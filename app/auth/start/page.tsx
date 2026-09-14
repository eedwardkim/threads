import type { Metadata } from "next";
import { GuestStart } from "@/components/guest-start";

export const metadata: Metadata = { title: "Opening Threads", robots: { index: false, follow: false } };

export default function GuestStartPage() {
  return <GuestStart />;
}
