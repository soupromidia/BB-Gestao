import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/messages — envia mensagem outbound (handler em ./_handler.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { sendMessageSchema, validateRequest, type SendMessageInput } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

import { sendMessageHandler } from "./_handler";

export const dynamic = "force-dynamic";

const IDEMPOTENCY_ENDPOINT = "/api/v1/messages";
const IDEMPOTENCY_PENDING_BODY = {
  error: {
    code: "idempotency_in_progress",
    message: "Envio ainda em processamento para esta Idempotency-Key.",
  },
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
    .join(",")}}`;
}

function requestHash(input: SendMessageInput): string {
  return createHash("sha256")
    .update(
      stableJson({
        body: input.body,
        conversation_id: input.conversation_id,
        media_mime: input.media_mime,
        media_size_bytes: input.media_size_bytes,
        media_storage_path: input.media_storage_path,
        media_url: input.media_url,
        metadata: input.metadata,
        reply_to_message_id: input.reply_to_message_id,
        template_language: input.template_language,
        template_name: input.template_name,
        template_values: input.template_values,
        type: input.type,
      }),
    )
    .digest("hex");
}

type IdempotencyReceipt = {
  id: string;
  request_hash: string;
  response_body: unknown;
  status_code: number;
};

function isPendingReceipt(receipt: IdempotencyReceipt): boolean {
  const body = receipt.response_body as { error?: { code?: unknown } } | null;
  return (
    receipt.status_code === 202 &&
    body?.error?.code === IDEMPOTENCY_PENDING_BODY.error.code
  );
}

function normalizeHash(raw: string): string {
  return raw.startsWith("\\x") ? raw.slice(2) : raw;
}

function idempotencyConflict(requestId: string): Response {
  return fail(
    "idempotency_conflict",
    "Idempotency-Key já usada com payload diferente.",
    409,
    { requestId },
  );
}

function idempotencyInProgress(requestId: string): Response {
  return fail(
    "idempotency_in_progress",
    "Envio ainda em processamento para esta Idempotency-Key.",
    409,
    { requestId },
  );
}

function replayReceipt(receipt: IdempotencyReceipt, requestId: string): Response {
  const body = receipt.response_body as { data?: unknown; error?: { code?: string; message?: string; details?: unknown } };
  if (body.error) {
    return fail(
      body.error.code ?? "internal_error",
      body.error.message ?? "Erro armazenado para esta Idempotency-Key.",
      receipt.status_code,
      { requestId, details: body.error.details },
    );
  }
  return ok(body.data ?? body, {
    status: receipt.status_code === 201 ? 201 : 200,
    requestId,
  });
}

async function loadReceipt(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  key: string,
  requestId: string,
): Promise<IdempotencyReceipt | null> {
  const { data, error } = await supabase
    .from("idempotency_keys")
    .select("id, request_hash, response_body, status_code")
    .eq("organization_id", orgId)
    .eq("key", key)
    .eq("endpoint", IDEMPOTENCY_ENDPOINT)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "internal_error", undefined, requestId, error.message);
  }
  return data as IdempotencyReceipt | null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  let input;
  try {
    input = await validateRequest(sendMessageSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const idempotencyKey =
    req.headers.get("Idempotency-Key") ?? req.headers.get("idempotency-key");
  const idemHash = requestHash(input as SendMessageInput);
  let reservedReceipt: IdempotencyReceipt | null = null;

  if (idempotencyKey) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data: inserted, error: insertErr } = await supabase
      .from("idempotency_keys")
      .insert({
        organization_id: activeOrg.orgId,
        key: idempotencyKey,
        endpoint: IDEMPOTENCY_ENDPOINT,
        request_hash: idemHash,
        status_code: 202,
        response_body: IDEMPOTENCY_PENDING_BODY,
        expires_at: expiresAt,
      })
      .select("id, request_hash, response_body, status_code")
      .single();

    if (insertErr) {
      if (insertErr.code !== "23505") {
        return fail("internal_error", insertErr.message, 500, { requestId });
      }
      const existing = await loadReceipt(supabase, activeOrg.orgId, idempotencyKey, requestId);
      if (!existing) {
        return idempotencyInProgress(requestId);
      }
      if (normalizeHash(existing.request_hash) !== idemHash) {
        return idempotencyConflict(requestId);
      }
      if (isPendingReceipt(existing)) {
        return idempotencyInProgress(requestId);
      }
      return replayReceipt(existing, requestId);
    }

    reservedReceipt = inserted as IdempotencyReceipt;
  }

  try {
    const message = await sendMessageHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: user.idioma,
      },
      input as SendMessageInput,
    );
    if (reservedReceipt) {
      const responseBody = { data: message };
      const { error: updateErr } = await supabase
        .from("idempotency_keys")
        .update({
          response_body: responseBody,
          status_code: 201,
        })
        .eq("organization_id", activeOrg.orgId)
        .eq("id", reservedReceipt.id);
      if (updateErr) {
        return fail("internal_error", updateErr.message, 500, { requestId });
      }
    }
    return ok(message, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      if (reservedReceipt) {
        const beforeExternalCodes = new Set([
          "contact_anonymized",
          "forbidden",
          "invalid_media_path",
          "invalid_payload",
          "missing_phone_number",
          "not_found",
          "validation_error",
        ]);
        if (beforeExternalCodes.has(err.code)) {
          await supabase
            .from("idempotency_keys")
            .delete()
            .eq("organization_id", activeOrg.orgId)
            .eq("id", reservedReceipt.id);
        } else {
          await supabase
            .from("idempotency_keys")
            .update({
              response_body: {
                error: {
                  code: err.code,
                  message: err.message,
                  details: err.details,
                },
              },
              status_code: err.status,
            })
            .eq("organization_id", activeOrg.orgId)
            .eq("id", reservedReceipt.id);
        }
      }
      return fail(err.code, err.message, err.status, { requestId });
    }
    if (reservedReceipt) {
      await supabase
        .from("idempotency_keys")
        .update({
          response_body: {
            error: {
              code: "message_send_uncertain",
              message:
                "O resultado do envio ficou incerto. A mesma Idempotency-Key não será reenviada automaticamente.",
            },
          },
          status_code: 500,
        })
        .eq("organization_id", activeOrg.orgId)
        .eq("id", reservedReceipt.id);
    }
    throw err;
  }
}
