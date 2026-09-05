import type { Metadata } from "next";
import { PrivacyPolicyDoc } from "../../components/PrivacyPolicyDoc";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How the merrymen software and website handle your data — short version: the software runs entirely on your machine, and the only thing we ever store is an email address you type into the iOS beta form.",
  alternates: { canonical: "/privacy" },
};

export default function Privacy() {
  return <PrivacyPolicyDoc />;
}
