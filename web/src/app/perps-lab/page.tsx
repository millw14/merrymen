import { redirect } from "next/navigation";

/** Retire the shared concept link in favor of the actual owner-connected desk. */
export default function PerpsLabPage() { redirect("/perps"); }
