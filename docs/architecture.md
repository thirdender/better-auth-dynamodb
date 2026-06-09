# Better Auth DynamoDB Adapter

## Table Schema

A single `Data` table with two indexes:

| Index | Hash Key | Range Key |
|---|---|---|
| Primary | `pk` | `sk` |
| GSI1 | `GSI1PK` | `GSI1SK` |

## Item Types and Key Patterns

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

## DynamoDB Operations

### GetItem
Direct key lookup after resolving the key via an index query. Used by `update`, `delete`, `findOne` (after index lookup), `deleteMany`, and the counter fallback in `count`.

### Query (primary index)
All query calls use **equality on `pk`** (hash key). The `begins_with` function is only applied to `sk` (sort key).

| Pattern | Purpose |
|---|---|
| `#pk = :pk` | Resolve email, session token, or verification identifier index items |
| `#pk = :pk AND #sk = :sk` | Resolve account by `providerId` + `accountId` |
| `#pk = :pk AND begins_with(#sk, :sk)` | Find all items of a model for a given `userId`; find all accounts for a `providerId` |
| Same as above + `Select: COUNT` | Count items by `userId` |

### Query (GSI1)
| Pattern | Purpose |
|---|---|
| `#pk1 = :pk1` with `GSI1PK = model_type#{model}` | Fallback `findMany` when no `userId`/`providerId` filter is present |

### TransactWrite (atomic multi-item)
Used by `create`, `update`, and `delete` to atomically write the main item, index items, and counter updates:

- **Create**: Put main item + Put index items + Update counter (ADD 1)
- **Update**: UpdateExpression + conditional Put/Delete index items if reindexing needed
- **Delete**: Delete main item + Delete index items + Update counter (ADD -1)

### BatchGet
Fetch main items in bulk after resolving their keys from index queries.

### BatchWrite
Delete main + index items in batches of 25 (used by `deleteMany`).

### UpdateCommand
- Individual item updates in `updateMany` (one per item found by `userId`)
- Atomic counter increment/decrement via `ADD #count :inc` / `ADD #count :dec`

### Put (conditional)
Acquire distributed lock: `attribute_not_exists(token) OR expiresAt < :now`.

### Delete (conditional)
Release distributed lock: `#token = :token`.

---

## Query Flow

```mermaid
flowchart TB
    subgraph BetterAuth["Better Auth Internal Adapter"]
        direction TB
        FS["findSession(token)"]
        FSS["findSessions(tokens)"]
        LS["listSessions(userId)"]
        UP["update(session)"]
        CR["create(model, data)"]
        DL["delete(model, where)"]
        DM["deleteMany(model, where)"]
        UPM["updateMany(model, where)"]
        CO["count(model)"]
        BC["create(user/account)"]
    end

    subgraph Adapter["Custom DynamoDB Adapter"]
        direction TB
        FO["findOne"]
        FM["findMany"]
        CRUD["create / update / delete / updateMany / deleteMany"]
        CNT["count"]
    end

    subgraph DynamoDB["DynamoDB Operations"]
        direction TB
        G["GetItem"]
        Q["Query<br/>(primary index)"]
        QG["Query<br/>(GSI1)"]
        T["TransactWrite"]
        BG["BatchGet"]
        BW["BatchWrite"]
        U["UpdateCommand"]
        PC["Put (condition<br/>expression)"]
        DC["Delete (condition<br/>expression)"]
    end

    FS --> FO
    FSS --> FM
    LS --> FM
    UP --> FO
    UP --> CRUD

    FO -->|"key from index"| G
    FO -->|"join.user"| G
    FM -->|"userId filter"| Q
    FM -->|"provider filter"| Q & BG
    FM -->|"fallback"| QG
    CRUD --> T
    CRUD --> U
    DM --> BW
    DM --> U
    UPM --> U
    CNT -->|"userId filter"| Q
    CNT -->|"no filter"| G

    Q -.-|"#pk=:pk<br/>for index items"| D1["email, session token,<br/>identifier"]
    Q -.-|"#pk=:pk AND #sk=:sk"| D2["provider + accountId"]
    Q -.-|"#pk=:pk AND<br/>begins_with(#sk,:sk)"| D3["userId index,<br/>provider index"]
    QG -.-|"GSI1PK=:pk"| D4["model_type#user<br/>model_type#session, etc."]
    T -.-|"create: put +<br/>counter + idx<br/>delete: delete +<br/>counter + idx"| D5["Atomic counter<br/>tracking"]
```

---

## Operation Details

```mermaid
flowchart LR
    subgraph CREATE["create(model, data)"]
        TI["transformInput"]
        TWC["TransactWrite:"]
        P["Put main item<br/>(pk=model#id, sk=model#id,<br/>GSI1PK=model_type#model)"]
        PT["Put index items<br/>(email, token, userId, etc.)"]
        AC["Update cnt: ADD #count 1"]
        TI --> TWC
        TWC --> P
        TWC --> PT
        TWC --> AC
    end

    subgraph FINDONE["findOne(model, where)"]
        KW["keyFromWhere<br/>(look for id=)"]
        FI["findItemViaIndex<br/>(lookup by email,<br/>token, identifier,<br/>or provider+accountId)"]
        KW -->|"null"| FI
        FI -->|"no match"| N["return null"]
        FI -->|"match"| GK["GetItem(key)"]
        KW -->|"id match"| GK
        GK -->|"join.user"| UQ["GetItem(user#userId)"]
        UQ --> OUT["transformOutput + return"]
        GK --> OUT
    end

    subgraph FINDMANY["findMany(model, where, join)"]
        UID{"userId in where?"}
        UID -->|"yes"| UQ2["Query userId index<br/>(#pk=:pk AND begins_with #sk)"]
        UQ2 --> BG2["BatchGet main items<br/>by resolved keys"]
        UID -->|"no"| PR{"account +<br/>providerId?"}
        PR -->|"yes"| PQ["Query provider index<br/>(#pk=:pk AND begins_with #sk)"]
        PQ --> BG3["BatchGet main items"]
        PR -->|"no"| VI{"verification +<br/>identifier?"}
        VI -->|"yes"| IQ["Query identifier index<br/>(#pk=:pk)"]
        IQ --> BG4["BatchGet main items"]
        VI -->|"no"| FQ["Query GSI1<br/>(GSI1PK=model_type#model)"]
        BG2 -->|"join.user"| AU["attachUser:<br/>GetItem per userId"]
        BG3 --> AU
        BG4 --> AU
        FQ --> AU
    end

    subgraph UPDATE_DELETE["update / updateMany / deleteMany"]
        subgraph UPDATE["update(model, where, update)"]
            KW2["resolve key<br/>(id or index)"]
            KW2 --> EX["GetItem existing"]
            EX --> TI2["transformInput"]
            TI2 --> BE["buildUpdateExpression"]
            BE --> TWC2["TransactWrite:<br/>Update + index sync"]
        end

        subgraph UPDATEMANY["updateMany(model, where, update)"]
            UI{"userId in where?"}
            UI -->|"yes"| UQU["Query userId index<br/>for items"]
            UQU -->|"foreach item"| UPD["UpdateCommand"]
            UI -->|"no"| Z["return 0"]
        end

        subgraph DELETEMANY["deleteMany(model, where)"]
            AL["acquireLock<br/>(Put conditional)"]
            AL -->|"fail"| THROW["throw"]
            AL -->|"success"| DU["Query userId index"]
            DU --> BWD["BatchWrite deletes<br/>(25 per batch)"]
            BWD --> DC2["Update cnt: ADD #count -N"]
            DC2 --> RL["releaseLock<br/>(Delete conditional)"]
        end
    end
```

---

## Performance Benchmarks

Run from local machine to DynamoDB (us-east-1) over internet. In production (Lambda in-region), expect **5-10x lower** latencies.

**Setup**: 100 users + 50 sessions seeded. Each operation iterated N times (100 for single-item, 20 for GSI1/count, 10 for userId queries).

| Operation | p50 (ms) | p95 (ms) | DynamoDB Calls |
|---|---|---|---|
| **findUserById** | 97 | 112 | 1 GetItem |
| **findUserByEmail** | 204 | 303 | 2 GetItems (index → main) |
| **findSessionByToken** | 204 | 222 | 2 GetItems (index → main) |
| **listUsers (GSI1)** | 99 | 214 | 1 Query on GSI |
| **countUsers** | 94 | 156 | 1 GetItem (counter) |
| **findSessionsByUserId** | 201 | 215 | 1 Query + 1 BatchGet |

**Key findings**:
- All access patterns use proper key-based lookups (primary key or GSI hash key with equality) — **no scans or expensive operations**.
- Multi-item lookups (email, session token, userId) add one sequential GetItem for the index pointer, roughly doubling latency vs direct ID lookup.
- **Performance is O(1) with respect to table size** — DynamoDB GetItem/Query latency on hash key does not degrade as the table grows.
- Bulk counter via `TransactWrite` `ADD` and counter GetItem are both sub-millisecond DynamoDB operations (network-bound here).

Run the benchmark yourself:
```bash
AWS_PROFILE=personal npx tsx scripts/benchmark-auth.ts <table-name> --seed --cleanup
```
