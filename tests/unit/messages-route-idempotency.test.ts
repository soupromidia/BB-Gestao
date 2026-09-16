import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const CONV = "44444444-4444-4444-8444-444444444444";

type Receipt = {
  id: string;
  organization_id: string;
  key: string;
  endpoint: string;
  request_hash: string;
  response_body: unknown;
  status_code: number;
  expires_at?: string;
};

type Message = {
  id: string;
  organization_id: string;
  conversation_id: string;
  type: string;
  body: string;
  status: string;
  external_id: string | null;
  sent_at: string;
};

let orgId = ORG_A;
let receipts: Receipt[] = [];
let sendCalls = 0;
let sendMode: "success" | "api-before" | "uncertain" | "deferred" = "success";
let releaseDeferred: (() => void) | null = null;

function payload(body = "oi") {
  return { conversation_id: CONV, type: "text", body };
}

function makeRequest(key: string | null, body = "oi") {
  return new Request("http://localhost/api/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(payload(body)),
  });
}

function selectReceipt(filters: Partial<Receipt>) {
  return receipts.find((row) =>
    Object.entries(filters).every(([key, value]) => row[key as keyof Receipt] === value),
  );
}

function fakeSupabase() {
  return {
    from(table: string) {
      if (table !== "idempotency_keys") throw new Error(`Tabela inesperada: ${table}`);

      return {
        insert(row: Omit<Receipt, "id">) {
          const existing = selectReceipt({
            organization_id: row.organization_id,
            key: row.key,
            endpoint: row.endpoint,
          });
          if (existing) {
            return {
              select: () => ({
                single: async () => ({
                  data: null,
                  error: {
                    code: "23505",
                    message: "duplicate key value violates unique constraint",
                  },
                }),
              }),
            };
          }
          const receipt = { id: randomUUID(), ...row };
          receipts.push(receipt);
          return {
            select: () => ({
              single: async () => ({ data: { ...receipt }, error: null }),
            }),
          };
        },
        select: () => {
          const filters: Partial<Receipt> = {};
          const q = {
            eq(column: keyof Receipt, value: string) {
              filters[column] = value as never;
              return q;
            },
            maybeSingle: async () => ({
              data: selectReceipt(filters) ? { ...selectReceipt(filters)! } : null,
              error: null,
            }),
          };
          return q;
        },
        update(patch: Partial<Receipt>) {
          const filters: Partial<Receipt> = {};
          const q = {
            eq(column: keyof Receipt, value: string) {
              filters[column] = value as never;
              return q;
            },
            then(resolve: (value: { error: null }) => unknown) {
              const receipt = selectReceipt(filters);
              if (receipt) Object.assign(receipt, patch);
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return q;
        },
        delete() {
          const filters: Partial<Receipt> = {};
          const q = {
            eq(column: keyof Receipt, value: string) {
              filters[column] = value as never;
              return q;
            },
            then(resolve: (value: { error: null }) => unknown) {
              receipts = receipts.filter((row) => row !== selectReceipt(filters));
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return q;
        },
      };
    },
  };
}

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => fakeSupabase()) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId },
  })),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: vi.fn(async (_supabase, ctx, input): Promise<Message> => {
    sendCalls += 1;
    if (sendMode === "deferred") {
      await new Promise<void>((resolve) => {
        releaseDeferred = resolve;
      });
    }
    if (sendMode === "api-before") {
      throw new ApiError(404, "not_found", undefined, ctx.requestId, "Conversa não encontrada.");
    }
    if (sendMode === "uncertain") {
      throw new Error("adapter accepted and process crashed before receipt");
    }
    return {
      id: `msg-${sendCalls}`,
      organization_id: ctx.organization_id,
      conversation_id: input.conversation_id,
      type: input.type,
      body: input.body ?? "",
      status: "sent",
      external_id: `ext-${sendCalls}`,
      sent_at: "2026-09-16T12:00:00.000Z",
    };
  }),
}));

async function post(key: string | null, body = "oi") {
  const { POST } = await import("@/app/api/v1/messages/route");
  return POST(makeRequest(key, body) as never);
}

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  orgId = ORG_A;
  receipts = [];
  sendCalls = 0;
  sendMode = "success";
  releaseDeferred = null;
});

describe("POST /api/v1/messages — Idempotency-Key", () => {
  it("primeiro POST com chave reserva antes e envia uma única vez", async () => {
    const res = await post("idem-1");

    expect(res.status).toBe(201);
    expect(sendCalls).toBe(1);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ organization_id: ORG_A, key: "idem-1", status_code: 201 });
  });

  it("replay da mesma chave e mesmo payload retorna o recibo sem reenviar", async () => {
    const first = await post("idem-2");
    const second = await post("idem-2");

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(sendCalls).toBe(1);
    expect(await json(second)).toMatchObject({ data: { id: "msg-1", external_id: "ext-1" } });
  });

  it("duas requisições concorrentes com a mesma chave não produzem dois envios", async () => {
    sendMode = "deferred";

    const first = post("idem-race");
    await vi.waitFor(() => expect(sendCalls).toBe(1));
    const second = await post("idem-race");
    releaseDeferred?.();
    const completedFirst = await first;

    expect(second.status).toBe(409);
    expect(await json(second)).toMatchObject({
      error: { code: "idempotency_in_progress" },
    });
    expect(completedFirst.status).toBe(201);
    expect(sendCalls).toBe(1);
  });

  it("mesma chave com payload diferente retorna conflito e não reenvia", async () => {
    await post("idem-conflict", "oi");
    const conflict = await post("idem-conflict", "outro texto");

    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({
      error: { code: "idempotency_conflict" },
    });
    expect(sendCalls).toBe(1);
  });

  it("organizações diferentes não colidem com a mesma chave", async () => {
    await post("idem-org");
    orgId = ORG_B;
    const secondOrg = await post("idem-org");

    expect(secondOrg.status).toBe(201);
    expect(sendCalls).toBe(2);
    expect(receipts.map((row) => row.organization_id).sort()).toEqual([ORG_A, ORG_B].sort());
  });

  it("falha antes do efeito externo remove a reserva para permitir nova tentativa legítima", async () => {
    sendMode = "api-before";
    const failed = await post("idem-before");

    expect(failed.status).toBe(404);
    expect(receipts).toHaveLength(0);

    sendMode = "success";
    const retry = await post("idem-before");
    expect(retry.status).toBe(201);
    expect(sendCalls).toBe(2);
  });

  it("resultado incerto após o efeito externo fica armazenado e não permite reenvio cego", async () => {
    sendMode = "uncertain";
    await expect(post("idem-uncertain")).rejects.toThrow("adapter accepted");
    expect(sendCalls).toBe(1);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.response_body).toMatchObject({
      error: { code: "message_send_uncertain" },
    });

    sendMode = "success";
    const replay = await post("idem-uncertain");

    expect(replay.status).toBe(500);
    expect(await json(replay)).toMatchObject({
      error: { code: "message_send_uncertain" },
    });
    expect(sendCalls).toBe(1);
  });
});
