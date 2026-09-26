import type { Metadata } from "next";
import { PrivacyPolicyDoc } from "../../components/PrivacyPolicyDoc";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What the hosted Merrymen service, its MCP connector for AI assistants, this website and the self-hosted software collect, why, how long it is kept, and who receives it.",
  alternates: { canonical: "/privacy" },
};

export default function Privacy() {
  return <PrivacyPolicyDoc />;
}
