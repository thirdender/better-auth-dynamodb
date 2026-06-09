import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  TransactWriteCommand,
  QueryCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.TABLE_NAME;
let client: DynamoDBDocumentClient;

function now() {
  return performance.now();
}

async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = now();
  const result = await fn();
  return [result, now() - start];
}

function stats(latencies: number[]) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  const avg = sorted.reduce((a, b) => a + b, 0) / n;
  const p50 = sorted[Math.floor(n * 0.5)];
  const p95 = sorted[Math.floor(n * 0.95)];
  const p99 = sorted[Math.floor(n * 0.99)];
  const min = sorted[0];
  const max = sorted[n - 1];
  return { avg: avg.toFixed(2), p50: p50.toFixed(2), p95: p95.toFixed(2), p99: p99.toFixed(2), min: min.toFixed(2), max: max.toFixed(2), n };
}

const UID = Math.random().toString(36).slice(2, 10);
const N = 100;
const IDS = Array.from({ length: N }, (_, i) => `bench_${UID}_${i}`);
const EMAILS = IDS.map((id) => `bench_${id}@test.com`);
const SESSION_TOKENS = IDS.slice(0, 50).map((_, i) => `bench_session_${UID}_${i}`);

async function seed() {
  console.log(`\nSeeding ${IDS.length} test users...`);
  for (let i = 0; i < IDS.length; i++) {
    const userId = IDS[i];
    const email = EMAILS[i];
    const [_, ms] = await time(() =>
      client.send(
        new TransactWriteCommand({
          TableName: TABLE_NAME,
          TransactItems: [
            {
              Put: {
                TableName: TABLE_NAME,
                Item: {
                  pk: `user#${userId}`,
                  sk: `user#${userId}`,
                  GSI1PK: "model_type#user",
                  GSI1SK: `user#${userId}`,
                  id: userId,
                  email,
                  name: `Bench User ${i}`,
                  createdAt: new Date().toISOString(),
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: TABLE_NAME,
                Item: {
                  pk: `_idx#user_email#${email}`,
                  sk: `user#${userId}`,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Update: {
                TableName: TABLE_NAME,
                Key: { pk: "_cnt#user", sk: "_cnt#user" },
                UpdateExpression: "ADD #c :one",
                ExpressionAttributeNames: { "#c": "count" },
                ExpressionAttributeValues: { ":one": 1 },
              },
            },
          ],
        }),
      ),
    );
    if (i === 0 || i === N - 1 || (i + 1) % 20 === 0) {
      console.log(`  Seeded user ${i + 1}/${N} (${ms.toFixed(1)}ms)`);
    }
  }

  console.log(`  Seeding sessions...`);
  for (let i = 0; i < SESSION_TOKENS.length; i++) {
    const userId = IDS[i];
    const token = SESSION_TOKENS[i];
    const sessionId = `bench_ses_${UID}_${i}`;
    await client.send(
      new TransactWriteCommand({
        TableName: TABLE_NAME,
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                pk: `session#${sessionId}`,
                sk: `session#${sessionId}`,
                GSI1PK: "model_type#session",
                GSI1SK: `session#${sessionId}`,
                id: sessionId,
                userId,
                token,
                userAgent: "benchmark",
                expiresAt: new Date(Date.now() + 86400000).toISOString(),
                createdAt: new Date().toISOString(),
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                pk: `_idx#session_token#${token}`,
                sk: `session#${sessionId}`,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                pk: `_idx#userId#${userId}`,
                sk: `session#${sessionId}`,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }),
    );
  }
  console.log(`  Seeded ${SESSION_TOKENS.length} sessions`);
}

async function cleanup() {
  console.log(`\nCleaning up test data...`);
  const toDelete: { pk: string; sk: string }[] = [];
  for (let i = 0; i < N; i++) {
    const userId = IDS[i];
    const email = EMAILS[i];
    toDelete.push({ pk: `user#${userId}`, sk: `user#${userId}` });
    toDelete.push({ pk: `_idx#user_email#${email}`, sk: `user#${userId}` });
    const sessionId = `bench_ses_${UID}_${i}`;
    toDelete.push({ pk: `session#${sessionId}`, sk: `session#${sessionId}` });
    toDelete.push({ pk: `_idx#session_token#${SESSION_TOKENS[i]}`, sk: `session#${sessionId}` });
    toDelete.push({ pk: `_idx#userId#${userId}`, sk: `session#${sessionId}` });
  }
  const seen = new Set<string>();
  const unique = toDelete.filter((k) => {
    const key = `${k.pk}#${k.sk}`;
    if (k.pk && k.sk && !seen.has(key)) {
      seen.add(key);
      return true;
    }
    return false;
  });
  for (const item of unique) {
    try {
      await client.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: item.pk, sk: item.sk } }));
    } catch {}
  }
  try {
    await client.send(
      new TransactWriteCommand({
        TableName: TABLE_NAME,
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { pk: "_cnt#user", sk: "_cnt#user" },
              UpdateExpression: "ADD #c :val",
              ExpressionAttributeNames: { "#c": "count" },
              ExpressionAttributeValues: { ":val": -N },
            },
          },
        ],
      }),
    );
  } catch {}
  console.log(`  Deleted ${unique.length} items`);
}

async function benchmarkFindByEmail() {
  console.log("\n─── findUserByEmail ───");
  const latencies: number[] = [];
  for (let i = 0; i < N; i++) {
    const email = EMAILS[i];
    const userId = IDS[i];
    const [_, ms] = await time(async () => {
      const idx = await client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { pk: `_idx#user_email#${email}`, sk: `user#${userId}` } }),
      );
      if (idx.Item) {
        await client.send(
          new GetCommand({ TableName: TABLE_NAME, Key: { pk: idx.Item.sk as string, sk: idx.Item.sk as string } }),
        );
      }
    });
    latencies.push(ms);
  }
  console.table([stats(latencies)]);
}

async function benchmarkFindById() {
  console.log("\n─── findUserById ───");
  const latencies: number[] = [];
  for (let i = 0; i < N; i++) {
    const [_, ms] = await time(() =>
      client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { pk: `user#${IDS[i]}`, sk: `user#${IDS[i]}` } }),
      ),
    );
    latencies.push(ms);
  }
  console.table([stats(latencies)]);
}

async function benchmarkFindBySessionToken() {
  console.log("\n─── findSessionByToken ───");
  const latencies: number[] = [];
  for (let i = 0; i < SESSION_TOKENS.length; i++) {
    const token = SESSION_TOKENS[i];
    const sessionId = `bench_ses_${UID}_${i}`;
    const [_, ms] = await time(async () => {
      const idx = await client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { pk: `_idx#session_token#${token}`, sk: `session#${sessionId}` } }),
      );
      if (idx.Item) {
        await client.send(
          new GetCommand({ TableName: TABLE_NAME, Key: { pk: idx.Item.sk as string, sk: idx.Item.sk as string } }),
        );
      }
    });
    latencies.push(ms);
  }
  console.table([stats(latencies)]);
}

async function benchmarkListUsers() {
  console.log("\n─── listUsers (GSI1 Query) ───");
  const latencies: number[] = [];
  for (let i = 0; i < 20; i++) {
    const [_, ms] = await time(() =>
      client.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": "model_type#user" },
          Limit: 50,
        }),
      ),
    );
    latencies.push(ms);
  }
  console.table([stats(latencies)]);
}

async function benchmarkCount() {
  console.log("\n─── countUsers (counter GetItem) ───");
  const latencies: number[] = [];
  for (let i = 0; i < 20; i++) {
    const [_, ms] = await time(() =>
      client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { pk: "_cnt#user", sk: "_cnt#user" } }),
      ),
    );
    latencies.push(ms);
  }
  console.table([stats(latencies)]);
}

async function benchmarkFindSessionsByUserId() {
  console.log("\n─── findSessionsByUserId (index query + BatchGet) ───");
  const latencies: number[] = [];
  const sampleIds = IDS.slice(0, 10);
  for (const userId of sampleIds) {
    const [_, ms] = await time(async () => {
      const idxQuery = await client.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `_idx#userId#${userId}`,
            ":prefix": "session#",
          },
        }),
      );
      const keys = (idxQuery.Items || []).map((item) => ({ pk: item.sk as string, sk: item.sk as string }));
      if (keys.length > 0) {
        await client.send(
          new BatchGetCommand({
            TableName: TABLE_NAME,
            RequestItems: { [TABLE_NAME]: { Keys: keys } },
          }),
        );
      }
    });
    latencies.push(ms);
  }
  console.table([stats(latencies)]);
}

async function main() {
  const count = (await client.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: "_cnt#user", sk: "_cnt#user" } }))).Item
    ?.count ?? 0;
  console.log(`\nCurrent user count: ${count}`);
  console.log(`Table: ${TABLE_NAME}`);
  console.log(`Run ID: ${UID}`);

  console.log("\n═══════════════════════════════════════");
  console.log("       better-auth-dynamodb BENCHMARKS");
  console.log("═══════════════════════════════════════");
  console.log(`  Users seeded:    ${N}`);
  console.log(`  Sessions seeded: ${SESSION_TOKENS.length}`);
  console.log(`  Iterations per op: ${N} (GSI1/count: 20, userId query: 10)`);
  console.log("  All times in milliseconds (lower = better)");
  console.log("═══════════════════════════════════════\n");

  await benchmarkFindById();
  await benchmarkFindByEmail();
  await benchmarkFindBySessionToken();
  await benchmarkListUsers();
  await benchmarkCount();
  await benchmarkFindSessionsByUserId();

  console.log("\n═══════════════════════════════════════");
  console.log("              BENCHMARK COMPLETE");
  console.log("═══════════════════════════════════════\n");
}

async function run() {
  const args = process.argv.slice(2);
  TABLE_NAME = TABLE_NAME || args[0];

  if (!TABLE_NAME) {
    console.error("Usage: TABLE_NAME=my-table npx tsx scripts/benchmark.ts [--seed] [--cleanup]");
    console.error("  or:   npx tsx scripts/benchmark.ts <table-name> [--seed] [--cleanup]");
    process.exit(1);
  }

  client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const runSeed = args.includes("--seed");
  const runCleanup = args.includes("--cleanup");

  if (runSeed && runCleanup) {
    await seed();
    await main();
    await cleanup();
  } else if (runSeed) {
    await seed();
  } else if (runCleanup) {
    await cleanup();
  } else {
    await main();
  }
}

run().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
