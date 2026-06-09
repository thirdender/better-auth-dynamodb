# better-auth-dynamodb

DynamoDB adapter for [Better Auth](https://better-auth.com).

## Installation

```bash
npm install better-auth-dynamodb @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb better-auth
```

## Usage

```ts
import { betterAuth } from "better-auth";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { dynamoDbAdapter } from "better-auth-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const auth = betterAuth({
  database: dynamoDbAdapter({
    client,
    tableName: "your-dynamodb-table-name",
    maxAttempts: 5, // optional, default 5
  }),
  // ... your Better Auth config (emailAndPassword, socialProviders, plugins, etc.)
});
```

## Required DynamoDB Table Schema

The adapter expects a single DynamoDB table with the following schema:

| Index | Hash Key | Range Key |
|---|---|---|
| **Primary** | `pk` (String) | `sk` (String) |
| **GSI1** | `GSI1PK` (String) | `GSI1SK` (String) |

Name the GSI `GSI1`.

## Key Pattern

| Type | `pk` | `sk` | `GSI1PK` | `GSI1SK` |
|---|---|---|---|---|
| **Main item** | `{model}#{id}` | `{model}#{id}` | `model_type#{model}` | `{model}#{id}` |
| **Counter** | `_cnt#{model}` | `_cnt#{model}` | — | — |
| **Email index** | `_idx#user_email#{email}` | `user#{id}` | — | — |
| **Session token index** | `_idx#session_token#{token}` | `session#{id}` | — | — |
| **Identifier index** | `_idx#identifier#{val}` | `verification#{id}` | — | — |
| **Provider index** | `_idx#provider#{providerId}` | `account#{accountId}` | — | — |
| **UserId index** | `_idx#userId#{userId}` | `{model}#{id}` | — | — |
| **Lock** | `_lock#{scope}` | `_lock#{scope}` | — | — |

Models: `user`, `session`, `account`, `verification`.

## Adapter Features

### Index-Item Pattern
Lookup fields (email, session token, verification identifier, provider+accountId, userId) are stored as lightweight pointer items at `pk = _idx#<prefix>`. This means all lookups use the primary key only — no GSI needed for individual lookups.

### Atomic Counters
Maintains per-model counters via `TransactWriteItems` with `ADD` operations, so `count()` is a single `GetItem` call rather than a scan.

### TransactWrite for Create/Update/Delete
Ensures consistency between the main item, index items, and counter updates.

### Lock-Based deleteMany
Uses conditional `PutItem` with TTL for distributed locking, preventing concurrent `deleteMany` calls from racing.

### Retry with Exponential Backoff
Wraps all DynamoDB calls with retry logic for `TransactionConflictException`, `ProvisionedThroughputExceededException`, and `InternalServerError`. Configurable via `maxAttempts`.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `client` | `DynamoDBDocumentClient` | required | DynamoDB document client |
| `tableName` | `string` | required | DynamoDB table name |
| `maxAttempts` | `number` | `5` | Max retry attempts for transient failures |

## Performance

Benchmarked from a local machine to DynamoDB (us-east-1) over the internet. In-production (Lambda in-region) latencies are typically 5-10x lower.

| Operation | p50 (ms) | p95 (ms) | DynamoDB Calls |
|---|---|---|---|
| **findUserById** | 97 | 112 | 1 GetItem |
| **findUserByEmail** | 204 | 303 | 2 GetItems (index → main) |
| **findSessionByToken** | 204 | 222 | 2 GetItems (index → main) |
| **listUsers (GSI1)** | 99 | 214 | 1 Query on GSI |
| **countUsers** | 94 | 156 | 1 GetItem (counter) |
| **findSessionsByUserId** | 201 | 215 | 1 Query + 1 BatchGet |

Run the benchmark yourself:

```bash
AWS_PROFILE=your-profile npx tsx scripts/benchmark.ts your-table-name --seed --cleanup
```

## Architecture

See [docs/architecture.md](./docs/architecture.md) for detailed query flow diagrams.

## License

MIT
