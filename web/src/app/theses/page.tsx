import { redirect } from "next/navigation";

/**
 * The feed moved to the front door.
 *
 * A redirect rather than a deletion: this URL has been shared, and a link
 * somebody pasted into a chat should not become a 404 because we reorganised
 * our own routing.
 */
export default function ThesesRedirect() {
  redirect("/feed");
}
