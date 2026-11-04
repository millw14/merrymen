import { redirect } from "next/navigation";

/** Renamed twice (/leaderboard, now /leaders). The old URL has been shared; keep it working. */
export default function ScoreboardRedirect() {
  redirect("/leaders");
}
