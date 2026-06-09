import { createAdapterFactory } from "better-auth/adapters";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  TransactWriteCommand,
  BatchWriteCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ConditionalCheckFailedException,
  TransactionConflictException,
  ProvisionedThroughputExceededException,
  InternalServerError,
} from "@aws-sdk/client-dynamodb";

/**
 * Configuration options for the DynamoDB adapter.
 */
interface DynamoDbAdapterConfig {
  /** An initialized DynamoDB DocumentClient instance */
  client: DynamoDBDocumentClient;
  /** Name of the DynamoDB table to use */
  tableName: string;
  /**
   * Maximum total attempts for transient DynamoDB failures
   * (throttling, transaction conflicts, server errors).
   * Defaults to 5 (1 initial + 4 retries).
   * Set to 1 to disable custom retry beyond the SDK's built-in logic.
   */
  maxAttempts?: number;
}

type Where = { field: string; operator: string; value: any };

/**
 * DynamoDB adapter for Better Auth.
 *
 * Uses an index-item pattern for efficient lookups:
 *   Main item:   pk = {model}#{id}, sk = {model}#{id}
 *   Counter:     pk = _cnt#{model}, sk = _cnt#{model}
 *   Lock:        pk = _lock#{scope}, sk = _lock#{scope}
 *   Index item:  pk = _idx#{prefix}, sk = {model}#{id}
 *
 * All index items point to their main item via the `sk` field.
 */
export const dynamoDbAdapter = (config: DynamoDbAdapterConfig) =>
  createAdapterFactory({
    config: {
      adapterId: "dynamodb",
      adapterName: "DynamoDB",
      usePlural: false,
      supportsJSON: false,
      supportsDates: false,
      supportsBooleans: false,
      supportsNumericIds: false,
      supportsUUIDs: false,
    },
    adapter: ({ transformInput, transformOutput }) => {
      const { client, tableName, maxAttempts = 5 } = config;

      /**
       * Checks whether a DynamoDB error should be retried.
       * Excludes ConditionalCheckFailedException — those are logical
       * condition failures that won't succeed on retry.
       */
      const isRetryableError = (e: unknown): boolean => {
        if (e instanceof TransactionConflictException) return true;
        if (e instanceof ProvisionedThroughputExceededException) return true;
        if (e instanceof InternalServerError) return true;
        return false;
      };

      /**
       * Wraps client.send() with exponential-backoff retry.
       * Uses full jitter: delay = min(2^attempt * 100ms + random(0,50ms), 2s).
       */
      const send = async <T = any>(command: any): Promise<T> => {
        let lastError: unknown;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            return (await client.send(command)) as T;
          } catch (e) {
            lastError = e;
            if (isRetryableError(e)) {
              const delay = Math.min(
                100 * Math.pow(2, attempt) + Math.random() * 50,
                2000,
              );
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }
            throw e;
          }
        }
        throw lastError;
      };

      const pk = (model: string, id: string) => `${model}#${id}`;
      const cntPk = (model: string) => `_cnt#${model}`;
      const idxPk = (prefix: string) => `_idx#${prefix}`;

      /**
       * Better Auth's internal adapter sometimes omits the operator for
       * equality checks (e.g. { field: "identifier", value: id }).
       * Treat missing/undefined as equality to match database conventions.
       */
      const isEq = (op: string | undefined) => !op || op === "eq" || op === "=";

      /**
       * When a where clause includes { field: "id", operator: "eq", value: id }
       * we can construct the primary key directly without an index query.
       */
      const keyFromWhere = (where: Where[], model: string) => {
        const id = where.find((w) => w.field === "id" && isEq(w.operator));
        if (id) return { pk: pk(model, id.value), sk: pk(model, id.value) };
        return null;
      };

      const getItemByKey = async (key: Record<string, string>) => {
        const result = await send<{ Item?: Record<string, any> }>(
          new GetCommand({ TableName: tableName, Key: key }),
        );
        return result.Item ?? null;
      };

      /**
       * Walk the where clause looking for an indexed field. When found,
       * query the index item (pk = _idx#{prefix}) to discover the main
       * item's primary key (stored in the index item's sk).
       *
       * Supports: user email, session token, verification identifier,
       * and composite account providerId + accountId lookups.
       */
      const findItemViaIndex = async (where: Where[], model: string) => {
        for (const condition of where) {
          if (!isEq(condition.operator)) continue;

          let prefix: string | null = null;
          if (model === "user" && condition.field === "email")
            prefix = `user_email#${condition.value}`;
          else if (model === "session" && condition.field === "token")
            prefix = `session_token#${condition.value}`;
          else if (model === "verification" && condition.field === "identifier")
            prefix = `identifier#${condition.value}`;

          if (prefix) {
            const result = await send<{ Items?: Record<string, any>[] }>(
              new QueryCommand({
                TableName: tableName,
                KeyConditionExpression: "#pk = :pk",
                ExpressionAttributeNames: { "#pk": "pk" },
                ExpressionAttributeValues: { ":pk": idxPk(prefix) },
                Limit: 1,
              }),
            );
            if (result.Items?.[0]) {
              const ref = result.Items[0].sk as string;
              return { pk: ref, sk: ref };
            }
            return null;
          }
        }

        // Account lookups require both providerId AND accountId (composite key).
        if (model === "account") {
          const providerId = where.find(
            (w) => w.field === "providerId" && isEq(w.operator),
          );
          const accountId = where.find(
            (w) => w.field === "accountId" && isEq(w.operator),
          );
          if (providerId && accountId) {
            const result = await send<{ Items?: Record<string, any>[] }>(
              new QueryCommand({
                TableName: tableName,
                KeyConditionExpression: "#pk = :pk AND #sk = :sk",
                ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
                ExpressionAttributeValues: {
                  ":pk": idxPk(`provider#${providerId.value}`),
                  ":sk": `account#${accountId.value}`,
                },
                Limit: 1,
              }),
            );
            if (result.Items?.[0]) {
              const ref = result.Items[0].sk as string;
              return { pk: ref, sk: ref };
            }
            return null;
          }
        }

        return null;
      };

      /**
       * Query the userId index to find all items of a given model belonging
       * to a user, then BatchGet the full main items.
       */
      const findItemsByUserId = async (model: string, userId: string) => {
        const result = await send<{ Items?: Record<string, any>[] }>(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
            ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
            ExpressionAttributeValues: {
              ":pk": idxPk(`userId#${userId}`),
              ":sk": `${model}#`,
            },
          }),
        );

        if (!result.Items?.length) return [];

        const keys = result.Items.map((item) => ({
          pk: item.sk as string,
          sk: item.sk as string,
        }));

        const batchResult = await send<{ Responses?: Record<string, any[]> }>(
          new BatchGetCommand({
            RequestItems: {
              [tableName]: { Keys: keys },
            },
          }),
        );

        return batchResult.Responses?.[tableName] ?? [];
      };

      /**
       * Build the set of index items that should exist for a given model record.
       * These are lightweight pointer items (just pk + sk) at
       * pk = _idx#{lookup} referencing the main item's key in the sk field.
       */
      const buildIndexItems = (
        model: string,
        data: Record<string, any>,
        id: string,
      ) => {
        const items: { pk: string; sk: string }[] = [];
        if (model === "user" && data.email) {
          items.push({
            pk: idxPk(`user_email#${data.email}`),
            sk: pk(model, id),
          });
        }
        if (model === "session") {
          if (data.token)
            items.push({
              pk: idxPk(`session_token#${data.token}`),
              sk: pk(model, id),
            });
          if (data.userId)
            items.push({
              pk: idxPk(`userId#${data.userId}`),
              sk: pk(model, id),
            });
        }
        if (model === "account") {
          if (data.userId)
            items.push({
              pk: idxPk(`userId#${data.userId}`),
              sk: pk(model, id),
            });
          if (data.providerId && data.accountId) {
            items.push({
              pk: idxPk(`provider#${data.providerId}`),
              sk: `account#${data.accountId}`,
            });
          }
        }
        if (model === "verification" && data.identifier) {
          items.push({
            pk: idxPk(`identifier#${data.identifier}`),
            sk: pk(model, id),
          });
        }
        return items;
      };

      /**
       * Convenience wrapper around buildIndexItems for reading the current
       * index keys of an existing record (used during re-indexing on update).
       */
      const findIndexKeysForItem = async (
        model: string,
        data: Record<string, any>,
      ) => {
        const id = data.id;
        if (!id) return [];
        return buildIndexItems(model, data, id);
      };

      /**
       * Derive a lock scope string from the where clause for deleteMany
       * serialisation. Scopes:
       *   - {model}#{userId}  — when userId filter present
       *   - {model}#cleanup   — when expiresAt filter present
       *   - {model}#global    — fallback
       */
      const deriveLockScope = (model: string, where: Where[]) => {
        const userId = where.find(
          (w) => w.field === "userId" && isEq(w.operator),
        );
        if (userId) return `${model}#${userId.value}`;
        const expiresAt = where.find(
          (w) => w.field === "expiresAt" && w.operator !== undefined,
        );
        if (expiresAt) return `${model}#cleanup`;
        return `${model}#global`;
      };

      /**
       * Acquire a distributed lock by putting a _lock#{scope} item with a
       * ConditionExpression that only succeeds when the lock is absent or
       * expired. Returns { scope, token } on success, or null if locked.
       */
      const acquireLock = async (
        model: string,
        where: Where[],
        timeout = 30,
      ) => {
        const scope = deriveLockScope(model, where);
        const token = crypto.randomUUID();
        const expiresAt = Math.floor(Date.now() / 1000) + timeout;
        try {
          await send(
            new PutCommand({
              TableName: tableName,
              Item: {
                pk: `_lock#${scope}`,
                sk: `_lock#${scope}`,
                token,
                expiresAt,
              },
              ConditionExpression:
                "attribute_not_exists(#token) OR #expiresAt < :now",
              ExpressionAttributeNames: {
                "#token": "token",
                "#expiresAt": "expiresAt",
              },
              ExpressionAttributeValues: {
                ":now": Math.floor(Date.now() / 1000),
              },
            }),
          );
          return { scope, token };
        } catch (e) {
          if (e instanceof ConditionalCheckFailedException) return null;
          throw e;
        }
      };

      /**
       * Release a previously acquired lock by deleting the lock item.
       * The ConditionExpression prevents releasing a lock owned by another
       * caller.
       */
      const releaseLock = async (scope: string, token: string) => {
        try {
          await send(
            new DeleteCommand({
              TableName: tableName,
              Key: { pk: `_lock#${scope}`, sk: `_lock#${scope}` },
              ConditionExpression: "#token = :token",
              ExpressionAttributeNames: { "#token": "token" },
              ExpressionAttributeValues: { ":token": token },
            }),
          );
        } catch (e) {
          if (e instanceof ConditionalCheckFailedException) return;
          throw e;
        }
      };

      /**
       * Build a DynamoDB UpdateExpression SET clause from a plain object,
       * skipping the internal pk/sk fields.
       */
      const buildUpdateExpression = (data: Record<string, any>) => {
        const names: Record<string, string> = {};
        const values: Record<string, any> = {};
        const setExprs: string[] = [];
        let i = 0;
        for (const [key, value] of Object.entries(data)) {
          if (key === "pk" || key === "sk") continue;
          const nameKey = `#f${i}`;
          const valueKey = `:v${i}`;
          names[nameKey] = key;
          values[valueKey] = value;
          setExprs.push(`${nameKey} = ${valueKey}`);
          i++;
        }
        if (setExprs.length === 0) return null;
        return {
          UpdateExpression: `SET ${setExprs.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        };
      };

      return {
        /**
         * Create a new model record. Atomically (via TransactWrite):
         *   1. Put the main item (pk = model#id, sk = model#id, with GSI1 keys)
         *   2. Put index items for lookups (email, token, userId, etc.)
         *   3. Increment the model counter (_cnt#{model})
         *
         * The main item Put uses a ConditionExpression to prevent overwriting
         * an existing record with the same id.
         */
        create: async <T extends Record<string, any>>({ model, data }: { model: string; data: T }) => {
          const transformed = await transformInput(data, model, "create");
          const id = transformed.id as string;
          if (!id) throw new Error("id is required");

          const mainKey = { pk: pk(model, id), sk: pk(model, id) };
          const mainItem = { ...mainKey, GSI1PK: `model_type#${model}`, GSI1SK: pk(model, id), ...transformed };
          const indexItems = buildIndexItems(model, transformed, id);

          const transactItems: any[] = [
            {
              Put: {
                TableName: tableName,
                Item: mainItem,
                ConditionExpression: "attribute_not_exists(#pk)",
                ExpressionAttributeNames: { "#pk": "pk" },
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: { pk: cntPk(model), sk: cntPk(model) },
                UpdateExpression: "ADD #count :inc",
                ExpressionAttributeNames: { "#count": "count" },
                ExpressionAttributeValues: { ":inc": 1 },
              },
            },
          ];

          for (const idx of indexItems) {
            transactItems.push({
              Put: { TableName: tableName, Item: idx },
            });
          }

          if (transactItems.length > 100) {
            throw new Error(
              `TransactWriteItem count (${transactItems.length}) exceeds DynamoDB limit of 100`,
            );
          }

          await send(new TransactWriteCommand({ TransactItems: transactItems }));
          return transformOutput(mainItem, model) as Promise<T>;
        },

        /**
         * Update a single record by its key (id lookup or index lookup).
         * If indexed fields changed (e.g. email, token, userId, providerId),
         * the old index items are cleaned up and new ones are created —
         * all within the same TransactWrite for consistency.
         */
        update: async <T>({ model, where, update: updateData }: { model: string; where: any[]; update: T }) => {
          const key =
            keyFromWhere(where, model) ??
            (await findItemViaIndex(where, model));
          if (!key) return null;

          const existing = await getItemByKey(key);
          if (!existing) return null;

          const transformedUpdate = await transformInput(updateData as Record<string, unknown>, model, "update");
          const expr = buildUpdateExpression(transformedUpdate);
          if (!expr) return transformOutput(existing, model) as Promise<T | null>;

          const transactItems: any[] = [
            {
              Update: {
                TableName: tableName,
                Key: key,
                UpdateExpression: expr.UpdateExpression,
                ExpressionAttributeNames: expr.ExpressionAttributeNames,
                ExpressionAttributeValues: expr.ExpressionAttributeValues,
              },
            },
          ];

          const changedFields = Object.keys(updateData as Record<string, any>);
          const needsReindex =
            (model === "user" && changedFields.includes("email")) ||
            (model === "session" &&
              (changedFields.includes("token") ||
                changedFields.includes("userId"))) ||
            (model === "account" &&
              (changedFields.includes("userId") ||
                changedFields.includes("providerId") ||
                changedFields.includes("accountId"))) ||
            (model === "verification" &&
              changedFields.includes("identifier"));

          if (needsReindex) {
            const oldIndexKeys = await findIndexKeysForItem(model, existing);
            const newData = { ...existing, ...transformedUpdate };
            const newIndexKeys = buildIndexItems(model, newData, existing.id);

            for (const oldKey of oldIndexKeys) {
              const stillExists = newIndexKeys.some(
                (k) => k.pk === oldKey.pk && k.sk === oldKey.sk,
              );
              if (!stillExists) {
                transactItems.push({
                  Delete: { TableName: tableName, Key: oldKey },
                });
              }
            }
            for (const newKey of newIndexKeys) {
              const alreadyExists = oldIndexKeys.some(
                (k) => k.pk === newKey.pk && k.sk === newKey.sk,
              );
              if (!alreadyExists) {
                transactItems.push({
                  Put: { TableName: tableName, Item: newKey },
                });
              }
            }
          }

          if (transactItems.length > 100) {
            throw new Error(
              `TransactWriteItem count (${transactItems.length}) exceeds DynamoDB limit of 100`,
            );
          }

          await send(new TransactWriteCommand({ TransactItems: transactItems }));

          const updated = await getItemByKey(key);
          return updated
            ? ((await transformOutput(updated, model)) as T)
            : null;
        },

        /**
         * Update all items of a model belonging to a user.
         * Iterates over items found via the userId index and issues individual
         * UpdateCommand calls (one per item).
         *
         * Only supports userId-scoped batches — returns 0 for unscoped calls.
         */
        updateMany: async ({ model, where, update: updateData }) => {
          const transformedUpdate = await transformInput(updateData, model, "update");
          const expr = buildUpdateExpression(transformedUpdate);
          if (!expr) return 0;

          const userId = where.find(
            (w: Where) => w.field === "userId" && isEq(w.operator),
          );
          if (userId) {
            const items = await findItemsByUserId(model, userId.value as string);
            let count = 0;
            for (const item of items) {
              await send(
                new UpdateCommand({
                  TableName: tableName,
                  Key: { pk: item.pk, sk: item.sk },
                  UpdateExpression: expr.UpdateExpression,
                  ExpressionAttributeNames: expr.ExpressionAttributeNames,
                  ExpressionAttributeValues: expr.ExpressionAttributeValues,
                }),
              );
              count++;
            }
            return count;
          }

          return 0;
        },

        /**
         * Delete a single record by its key. Atomically removes the main item,
         * all associated index items, and decrements the model counter.
         */
        delete: async ({ model, where }) => {
          const key =
            keyFromWhere(where, model) ??
            (await findItemViaIndex(where, model));
          if (!key) return;

          const existing = await getItemByKey(key);
          if (!existing) return;

          const indexKeys = await findIndexKeysForItem(model, existing);

          const transactItems: any[] = [
            { Delete: { TableName: tableName, Key: key } },
            {
              Update: {
                TableName: tableName,
                Key: { pk: cntPk(model), sk: cntPk(model) },
                UpdateExpression: "ADD #count :dec",
                ExpressionAttributeNames: { "#count": "count" },
                ExpressionAttributeValues: { ":dec": -1 },
              },
            },
          ];

          for (const idxKey of indexKeys) {
            transactItems.push({
              Delete: { TableName: tableName, Key: idxKey },
            });
          }

          if (transactItems.length > 100) {
            throw new Error(
              `TransactWriteItem count (${transactItems.length}) exceeds DynamoDB limit of 100`,
            );
          }

          await send(new TransactWriteCommand({ TransactItems: transactItems }));
        },

        /**
         * Delete all items of a model for a given user.
         *
         * Acquires a distributed lock first (to prevent concurrent deleteMany
         * calls from racing), then BatchWrite deletes in batches of 25, and
         * finally decrements the counter by the number of items removed.
         *
         * Only supports userId-scoped deletes — returns 0 for unscoped calls.
         */
        deleteMany: async ({ model, where }) => {
          const lock = await acquireLock(model, where);
          if (!lock) throw new Error("Could not acquire lock for deleteMany");

          try {
            const userId = where.find(
              (w: Where) => w.field === "userId" && isEq(w.operator),
            );
            if (!userId) return 0;

            const items = await findItemsByUserId(model, userId.value as string);
            if (items.length === 0) return 0;

            const deleteRequests: any[] = [];
            for (const item of items) {
              deleteRequests.push({
                DeleteRequest: { Key: { pk: item.pk, sk: item.sk } },
              });
              const indexKeys = await findIndexKeysForItem(model, item);
              for (const idxKey of indexKeys) {
                deleteRequests.push({
                  DeleteRequest: { Key: idxKey },
                });
              }
            }

            // DynamoDB BatchWrite has a 25-item limit per batch.
            for (let i = 0; i < deleteRequests.length; i += 25) {
              await send(
                new BatchWriteCommand({
                  RequestItems: {
                    [tableName]: deleteRequests.slice(i, i + 25),
                  },
                }),
              );
            }

            await send(
              new UpdateCommand({
                TableName: tableName,
                Key: { pk: cntPk(model), sk: cntPk(model) },
                UpdateExpression: "ADD #count :dec",
                ExpressionAttributeNames: { "#count": "count" },
                ExpressionAttributeValues: { ":dec": -items.length },
              }),
            );

            return items.length;
          } finally {
            await releaseLock(lock.scope, lock.token);
          }
        },

        /**
         * Find a single record by its key (id or index lookup).
         *
         * Supports `join: { user: true }` — when enabled, fetches the
         * linked user record and attaches it to the result.
         */
        findOne: async <T>({ model, where, join }: { model: string; where: any[]; join?: any }) => {
          const key =
            keyFromWhere(where, model) ??
            (await findItemViaIndex(where, model));
          if (!key) return null;
          const item = await getItemByKey(key);
          if (!item) return null;
          const output = await transformOutput(item, model);
          if (join?.user) {
            const userId = output.userId as string;
            if (userId) {
              const userItem = await getItemByKey({ pk: `user#${userId}`, sk: `user#${userId}` });
              if (userItem) {
                const user = await transformOutput(userItem, "user");
                return { ...output, user } as T;
              }
            }
          }
          return output as T;
        },

        /**
         * Find multiple records. The query strategy depends on the where clause:
         *
         *   1. **userId filter**       → Query userId index items, BatchGet main items
         *   2. **account + providerId**  → Query provider index items, BatchGet
         *   3. **verification + identifier** → Query identifier index items, BatchGet
         *   4. **fallback**              → Query GSI1 (model_type#{model})
         *
         * Supports `join: { user: true }` — attaches the linked user to each result.
         */
        findMany: async <T>({ model, where, limit, offset, join }: { model: string; where?: any[]; limit: number; offset?: number; join?: any }) => {
          const attachUser = async (items: Record<string, unknown>[]) => {
            if (!join?.user) return items;
            return Promise.all(
              items.map(async (item) => {
                const userId = item.userId as string;
                if (!userId) return item;
                const userItem = await getItemByKey({ pk: `user#${userId}`, sk: `user#${userId}` });
                if (!userItem) return item;
                const user = await transformOutput(userItem, "user");
                return { ...item, user };
              }),
            );
          };

          const userId = where?.find(
            (w: Where) => w.field === "userId" && isEq(w.operator),
          );
          if (userId) {
            let items = await findItemsByUserId(model, userId.value as string);
            if (offset) items = items.slice(offset);
            if (limit) items = items.slice(0, limit);
            const mapped = await Promise.all(
              items.map((item) => transformOutput(item, model)),
            );
            return attachUser(mapped) as Promise<T[]>;
          }

          if (model === "account") {
            const providerId = where?.find(
              (w: Where) => w.field === "providerId" && isEq(w.operator),
            );
            if (providerId) {
              const result = await send<{ Items?: Record<string, any>[] }>(
                new QueryCommand({
                  TableName: tableName,
                  KeyConditionExpression:
                    "#pk = :pk AND begins_with(#sk, :sk)",
                  ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
                  ExpressionAttributeValues: {
                    ":pk": idxPk(`provider#${providerId.value}`),
                    ":sk": "account#",
                  },
                }),
              );
              if (!result.Items?.length) return [] as T[];
              const keys = result.Items.map((item) => ({
                pk: item.sk as string,
                sk: item.sk as string,
              }));
              const batchResult = await send<{ Responses?: Record<string, any[]> }>(
                new BatchGetCommand({
                  RequestItems: { [tableName]: { Keys: keys } },
                }),
              );
              let items = batchResult.Responses?.[tableName] ?? [];
              if (offset) items = items.slice(offset);
              if (limit) items = items.slice(0, limit);
              const mapped = await Promise.all(
                items.map((item) => transformOutput(item, model)),
              );
              return attachUser(mapped) as Promise<T[]>;
            }
          }

          // Better Auth's internal adapter sends identifier conditions
          // without an operator — match on the field name directly.
          if (model === "verification") {
            const identifier = where?.find(
              (w: Where) => w.field === "identifier",
            );
            if (identifier) {
              const idxResult = await send<{ Items?: Record<string, any>[] }>(
                new QueryCommand({
                  TableName: tableName,
                  KeyConditionExpression: "#pk = :pk",
                  ExpressionAttributeNames: { "#pk": "pk" },
                  ExpressionAttributeValues: {
                    ":pk": idxPk(`identifier#${identifier.value}`),
                  },
                  Limit: limit || 1,
                }),
              );
              if (!idxResult.Items?.length) return [] as T[];
              const keys = idxResult.Items.map((item) => ({
                pk: item.sk as string,
                sk: item.sk as string,
              }));
              const batchResult = await send<{ Responses?: Record<string, any[]> }>(
                new BatchGetCommand({
                  RequestItems: { [tableName]: { Keys: keys } },
                }),
              );
              let items = batchResult.Responses?.[tableName] ?? [];
              if (offset) items = items.slice(offset);
              if (limit) items = items.slice(0, limit);
              const mapped = await Promise.all(
                items.map((item) => transformOutput(item, model)),
              );
              return attachUser(mapped) as Promise<T[]>;
            }
          }

          // Fallback: return all items of the model type using the GSI1 index.
          const result = await send<{ Items?: Record<string, any>[] }>(
            new QueryCommand({
              TableName: tableName,
              IndexName: "GSI1",
              KeyConditionExpression: "#pk1 = :pk1",
              ExpressionAttributeNames: { "#pk1": "GSI1PK" },
              ExpressionAttributeValues: { ":pk1": `model_type#${model}` },
            }),
          );
          let items = result.Items ?? [];
          if (offset) items = items.slice(offset);
          if (limit) items = items.slice(0, limit);
          const mapped = await Promise.all(
            items.map((item) => transformOutput(item, model)),
          );
          return attachUser(mapped) as Promise<T[]>;
        },

        /**
         * Count records. If a userId filter is present, queries the userId
         * index with Select: COUNT. Otherwise falls back to the dedicated
         * counter item (_cnt#{model}) maintained by create/delete operations.
         */
        count: async ({ model, where }) => {
          if (where && where.length > 0) {
            const userId = where.find(
              (w: Where) => w.field === "userId" && isEq(w.operator),
            );
            if (userId) {
              const result = await send<{ Count?: number }>(
                new QueryCommand({
                  TableName: tableName,
                  KeyConditionExpression:
                    "#pk = :pk AND begins_with(#sk, :sk)",
                  ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
                  ExpressionAttributeValues: {
                    ":pk": idxPk(`userId#${userId.value}`),
                    ":sk": `${model}#`,
                  },
                  Select: "COUNT",
                }),
              );
              return result.Count ?? 0;
            }
          }

          const counter = await getItemByKey({
            pk: cntPk(model),
            sk: cntPk(model),
          });
          return (counter?.count as number) ?? 0;
        },
      };
    },
  });
