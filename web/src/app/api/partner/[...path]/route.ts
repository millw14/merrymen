import { isHostedMode } from "@merrymen/core";
import { getPartnerStore } from "@/lib/partner-store";
import { createPartnerService, partnerFailure } from "@/lib/partner-service";
import { readPartnerRuntime, replyToPartner } from "@/lib/partner-runtime";
import { createPartnerEnrollmentService } from "@/lib/partner-enrollment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: Request, context: { params: Promise<{ path: string[] }> }) {
  if (!isHostedMode()) return Response.json({ error: { code: "not_found", message: "Hosted API only" } }, { status: 404 });
  try {
    const { path } = await context.params;
    const store = getPartnerStore();
    return await createPartnerService({ store, readRuntime: readPartnerRuntime, reply: replyToPartner,
      enrollment: createPartnerEnrollmentService({ store }) })
      .handle(req, `/${path.join("/")}`);
  } catch (error) { return partnerFailure(error); }
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
