import type { APIRoute } from "astro";
export const GET: APIRoute = async ({ locals }) => {
  const env = (locals as any).runtime?.env ?? {};
  const metaPixelId = /^\d{8,20}$/.test(String(env.META_PIXEL_ID ?? "")) ? String(env.META_PIXEL_ID) : null;
  return Response.json({ metaPixelId }, { headers: { "cache-control": "public, max-age=300" } });
};
