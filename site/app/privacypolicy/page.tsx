import type { Metadata } from "next";
import { PrivacyPolicyDoc } from "../../components/PrivacyPolicyDoc";

/**
 * The same policy, served at the spelling app stores, OAuth consoles, and ad
 * networks ask for when they want a "privacy policy URL". It is a real page
 * rather than a redirect because some of those reviewers reject a 3xx, and its
 * canonical points at /privacy so search engines index one of the two.
 */
export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What the hosted Merrymen service, its MCP connector for AI assistants, this website and the self-hosted software collect, why, how long it is kept, and who receives it.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPolicy() {
  return <PrivacyPolicyDoc />;
}
