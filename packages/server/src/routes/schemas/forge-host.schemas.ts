/**
 * Zod schemas for the install-wide forge host credential endpoints
 * (`/api/forge-hosts`). No secret value appears in any of these shapes:
 * list carries host metadata only, save/delete confirmations carry no token,
 * and the test-connection result carries the probe outcome only.
 */
import { z } from '@hono/zod-openapi';

/** One stored forge host — metadata only. */
export const forgeHostMetaSchema = z
  .object({
    host: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('ForgeHostMeta');

/** GET /api/forge-hosts response. */
export const forgeHostListResponseSchema = z
  .object({ hosts: z.array(forgeHostMetaSchema) })
  .openapi('ForgeHostListResponse');

/** PUT /api/forge-hosts/* request body — the credential, in transit only. */
export const forgeHostSaveBodySchema = z
  .object({
    token: z
      .string()
      .min(1)
      .refine(v => v.trim().length > 0, { message: 'token must not be blank' }),
  })
  .openapi('ForgeHostSaveBody');

/** PUT /api/forge-hosts/* response — secret-free confirmation. */
export const forgeHostSaveResponseSchema = z
  .object({ success: z.boolean(), host: z.string() })
  .openapi('ForgeHostSaveResponse');

/** DELETE /api/forge-hosts/* response (idempotent). */
export const forgeHostDeleteResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('ForgeHostDeleteResponse');

/** POST /api/forge-hosts/test request body — caller-supplied host + token. */
export const forgeHostTestBodySchema = z
  .object({
    host: z.string().min(1),
    token: z.string().min(1),
  })
  .openapi('ForgeHostTestBody');

/** POST /api/forge-hosts/test response — the probe result, no token. */
export const forgeHostTestResponseSchema = z
  .union([
    z.object({ ok: z.literal(true), login: z.string() }),
    z.object({
      ok: z.literal(false),
      kind: z.enum(['bad_token', 'unreachable', 'not_gitea_api']),
      message: z.string(),
    }),
  ])
  .openapi('ForgeHostTestResponse');
