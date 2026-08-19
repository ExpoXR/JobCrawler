import { resetProviderCache } from '@ejc/ai';
import {
  deleteModelProvider,
  listModelProviders,
  upsertModelProvider,
} from '@ejc/database';
import {
  AI_PROVIDERS,
  AppError,
  EMBEDDING_PROVIDERS,
  encryptSecret,
  isSecretStorageConfigured,
  secretLast4,
} from '@ejc/shared';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  assertSameOrigin,
  clientKey,
  handleRouteError,
  rateLimit,
  readJsonBody,
  tooManyRequests,
} from '@/lib/api';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Model provider configuration.
 *
 * **No response from this module ever contains an API key.** Stored keys are
 * encrypted at rest and surfaced only as `{ hasSecret, last4 }`, so the
 * dashboard can show *which* key is configured without being able to read it.
 */

/**
 * A base URL supplied by an administrator is deliberately allowed to point at a
 * private address — that is the whole point of running a local model, and it is
 * why this must not go through the crawler's SSRF guard. The compensating
 * controls are that only an administrator can set it, only http/https are
 * accepted, embedded credentials are refused, and every change is logged.
 */
const baseUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) => {
      if (!value) return true;
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        return !url.username && !url.password;
      } catch {
        return false;
      }
    },
    { message: 'Must be an http(s) URL without embedded credentials' },
  );

const saveSchema = z
  .object({
    kind: z.enum(['ai', 'embedding']),
    providerKey: z.string().trim().min(1).max(64),
    displayName: z.string().trim().max(120).optional(),
    enabled: z.boolean().default(true),
    model: z.string().trim().max(200).optional(),
    baseUrl: baseUrlSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    maxTokens: z.number().int().min(1).max(200_000).optional(),
    /**
     * Omit to keep the stored key; empty string to clear it. Retyping is not
     * required just to change a model name.
     */
    apiKey: z.string().max(1024).optional(),
    /** Alternative to `apiKey`: the name of an environment variable to read. */
    secretRef: z.string().trim().max(120).optional(),
  })
  .superRefine((value, ctx) => {
    const valid = value.kind === 'ai' ? AI_PROVIDERS : EMBEDDING_PROVIDERS;
    if (!(valid as readonly string[]).includes(value.providerKey)) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerKey'],
        message: `Unknown ${value.kind} provider. Expected one of: ${valid.join(', ')}`,
      });
    }
    if (value.providerKey === 'openai_compatible' && !value.baseUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'An OpenAI-compatible provider needs the endpoint it should talk to',
      });
    }
  });

const deleteSchema = z.object({ providerKey: z.string().trim().min(1).max(64) });

/** Strips everything that must not reach a browser. */
function present(record: Awaited<ReturnType<typeof listModelProviders>>[number]) {
  return {
    id: record.id,
    providerKey: record.providerKey,
    kind: record.kind,
    displayName: record.displayName,
    enabled: record.enabled,
    model: record.model,
    baseUrl: record.baseUrl,
    temperature: record.temperature,
    timeoutMs: record.timeoutMs,
    maxTokens: record.maxTokens,
    secretRef: record.secretRef,
    hasSecret: record.secretCiphertext !== null,
    last4: record.secretLast4,
    secretUpdatedAt: record.secretUpdatedAt,
    updatedAt: record.updatedAt,
  };
}

export async function GET(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'admin'), 60, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
    await requireAdmin();

    return NextResponse.json({
      providers: (await listModelProviders()).map(present),
      // The dashboard disables the key field when this is false, rather than
      // accepting a secret it would have to refuse on save.
      secretStorageConfigured: isSecretStorageConfigured(),
      available: { ai: AI_PROVIDERS, embedding: EMBEDDING_PROVIDERS },
    });
  } catch (error) {
    return handleRouteError(error, 'GET /api/admin/model-providers');
  }
}

export async function PUT(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'admin'), 60, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
    assertSameOrigin(request);
    const actor = await requireAdmin();

    const body = saveSchema.parse(await readJsonBody(request));

    if (body.apiKey !== undefined && body.apiKey !== '' && !isSecretStorageConfigured()) {
      throw new AppError(
        'not_configured',
        'SETTINGS_ENCRYPTION_KEY is not set, so an API key cannot be stored. ' +
          'Set it (openssl rand -base64 32), or point secretRef at an environment variable.',
      );
    }

    const record = await upsertModelProvider({
      providerKey: body.providerKey,
      kind: body.kind,
      enabled: body.enabled,
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
      ...(body.secretRef !== undefined ? { secretRef: body.secretRef || null } : {}),
      // undefined keeps the stored key, '' clears it, anything else replaces it.
      ...(body.apiKey === undefined
        ? {}
        : {
            secret:
              body.apiKey === ''
                ? null
                : {
                    ciphertext: encryptSecret(body.apiKey),
                    last4: secretLast4(body.apiKey),
                  },
          }),
    });

    // Both processes resolve settings through a short TTL; clearing here makes
    // the change visible to this one immediately.
    resetProviderCache();

    return NextResponse.json({ provider: present(record), actor: actor.email });
  } catch (error) {
    return handleRouteError(error, 'PUT /api/admin/model-providers');
  }
}

export async function DELETE(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'admin'), 60, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
    assertSameOrigin(request);
    await requireAdmin();

    const body = deleteSchema.parse(await readJsonBody(request));
    await deleteModelProvider(body.providerKey);
    resetProviderCache();

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, 'DELETE /api/admin/model-providers');
  }
}
