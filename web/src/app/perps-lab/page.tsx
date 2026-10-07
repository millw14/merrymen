import type { Metadata } from "next";
import { PerpsLabClient } from "./PerpsLabClient";
import "./lab.css";

export const metadata: Metadata = {
  title: "Perps mode concepts · Merrymen",
  description: "Three interactive visual concepts for a future Merrymen perps view. Fictional sample data only.",
  robots: { index: false, follow: false },
};

export default function PerpsLabPage() {
  return <PerpsLabClient />;
}
