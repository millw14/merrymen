import type { Metadata } from "next";
import { DeveloperConsole } from "./DeveloperConsole";
import "./developer.css";

const description = "Create your Merrymen API key, download the browser SDK, and build agent creation and chat into your app.";
const image = {
  url: "/social/merrymen-api-v2.png",
  width: 1733,
  height: 907,
  alt: "Merrymen API — Build agents into your app. A luminous green agent core connects code, chat and applications.",
};

export const metadata: Metadata = {
  title: "Developers — API & SDK",
  description,
  openGraph: {
    title: "Merrymen API — Build agents into your app",
    description,
    url: "https://merrymen.dev/api",
    siteName: "merrymen",
    type: "website",
    images: [image],
  },
  twitter: {
    card: "summary_large_image",
    title: "Merrymen API — Build agents into your app",
    description,
    site: "@MerrymenAI",
    images: [image],
  },
};
export default function ApiPage() { return <DeveloperConsole />; }
