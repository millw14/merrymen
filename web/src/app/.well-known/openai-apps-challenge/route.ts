/** Serve the exact domain proof issued by the OpenAI plugin submission portal. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Response {
  const token = process.env.MERRYMEN_OPENAI_APPS_CHALLENGE;
  if (!token || /[\r\n]/.test(token)) return new Response("Not found", { status: 404 });
  return new Response(token, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
