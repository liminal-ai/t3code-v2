import {
  ClaudeSettings,
  FORK_SETTINGS_WS_METHODS,
  ForkSettingsError,
  ForkSettingsGroups,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettingsService from "../serverSettings.ts";
import * as Limbase from "./Limbase.ts";

export type Owner =
  | { readonly scope: "thread"; readonly id: ThreadId }
  | { readonly scope: "instance"; readonly id: ProviderInstanceId };

export class ForkSettingsStore extends Context.Service<
  ForkSettingsStore,
  {
    readonly read: (owner: Owner) => Effect.Effect<ForkSettingsGroups, ForkSettingsError>;
    readonly write: (
      owner: Owner,
      groups: ForkSettingsGroups,
    ) => Effect.Effect<void, ForkSettingsError>;
  }
>()("t3/fork/ForkSettings/ForkSettingsStore") {}

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

export const claudeSettingsOf = (settings: ServerSettings, instanceId: ProviderInstanceId) => {
  const entry = settings.providerInstances[instanceId];
  return entry?.driver === CLAUDE_DRIVER
    ? Option.getOrUndefined(decodeClaudeSettings(entry.config ?? {}))
    : undefined;
};

export const hasLimbaseHome = (claude: ClaudeSettings | undefined) =>
  (claude?.limbaseHome?.trim() ?? "") !== "";

const decodeGroups = Schema.decodeUnknownEffect(ForkSettingsGroups);
const encodeGroups = Schema.encodeEffect(ForkSettingsGroups);
const StoredJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeStored = Schema.decodeEffect(StoredJson);
const encodeStored = Schema.encodeEffect(StoredJson);

export const storeError = (cause: unknown) =>
  new ForkSettingsError({
    message: `The settings store failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;

  const storedJson = (owner: Owner) =>
    sql<{ readonly settings: string }>`
      SELECT settings_json AS settings FROM fork_settings
      WHERE scope = ${owner.scope} AND owner_id = ${owner.id}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed({}) : decodeStored(rows[0].settings),
      ),
    );

  const upsert = Effect.fn("ForkSettings.upsert")(function* (
    owner: Owner,
    stored: Record<string, unknown>,
  ) {
    if (Object.keys(stored).length === 0) {
      yield* sql`DELETE FROM fork_settings WHERE scope = ${owner.scope} AND owner_id = ${owner.id}`;
      return;
    }
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO fork_settings (scope, owner_id, settings_json, updated_at)
      VALUES (${owner.scope}, ${owner.id}, ${yield* encodeStored(stored)}, ${updatedAt})
      ON CONFLICT (scope, owner_id)
      DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
    `;
  });

  const write = (owner: Owner, groups: ForkSettingsGroups) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const stored: Record<string, unknown> = { ...(yield* storedJson(owner)) };
          const encoded: Record<string, unknown> = yield* encodeGroups(groups);
          for (const [key, value] of Object.entries(encoded)) {
            if (typeof value === "object" && value !== null && Object.keys(value).length === 0) {
              delete stored[key];
            } else {
              stored[key] = value;
            }
          }
          yield* upsert(owner, stored);
        }),
      )
      .pipe(Effect.mapError(storeError));

  const keepFixedCompactionOnInstancesThatPredateSettings = Effect.fn(
    "ForkSettings.keepFixedCompactionOnInstancesThatPredateSettings",
  )(function* () {
    const settings = yield* serverSettings.getSettings;
    for (const id of Object.keys(settings.providerInstances) as ProviderInstanceId[]) {
      if (!hasLimbaseHome(claudeSettingsOf(settings, id))) continue;
      const kept: Record<string, unknown> = yield* encodeGroups({
        limbaseCompaction: Limbase.FIXED_COMPACTION_BEFORE_SETTINGS,
      });
      yield* upsert({ scope: "instance", id }, kept);
      yield* Effect.logInfo("fork-settings.seeded", { instanceId: id, ...kept });
    }
  });

  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql`
          SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fork_settings'
        `;
        if (existing.length > 0) return;
        yield* sql`
          CREATE TABLE fork_settings (
            scope TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            settings_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (scope, owner_id)
          )
        `;
        yield* keepFixedCompactionOnInstancesThatPredateSettings();
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("fork-settings.store-not-created", {
          retried: "at the next start",
          cause,
        }),
      ),
    );

  return ForkSettingsStore.of({
    read: Effect.fn("ForkSettingsStore.read")(function* (owner: Owner) {
      return yield* storedJson(owner).pipe(
        Effect.flatMap(decodeGroups),
        Effect.mapError(storeError),
      );
    }),
    write,
  });
});

export const layer = Layer.effect(ForkSettingsStore, make);

export const compaction = (
  store: Option.Option<ForkSettingsStore["Service"]>,
  input: {
    readonly threadId: ThreadId;
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly claudeContextWindow: () => number | null;
  },
): Limbase.Compaction | undefined =>
  Option.match(store, {
    onNone: () => undefined,
    onSome: (settings) => ({
      settings: Effect.all({
        thread: settings.read({ scope: "thread", id: input.threadId }),
        instance: settings.read({ scope: "instance", id: input.instanceId }),
      }).pipe(
        Effect.map(({ thread, instance }) => ({
          thread: thread.limbaseCompaction ?? {},
          instance: instance.limbaseCompaction ?? {},
        })),
      ),
      model: input.model,
      claudeContextWindow: input.claudeContextWindow,
    }),
  });

export const RPC_AGGREGATES = {
  [FORK_SETTINGS_WS_METHODS.getThread]: "forkSettings",
  [FORK_SETTINGS_WS_METHODS.setThread]: "forkSettings",
  [FORK_SETTINGS_WS_METHODS.getInstance]: "forkSettings",
  [FORK_SETTINGS_WS_METHODS.setInstance]: "forkSettings",
} as const;
