"use client";

import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="empty-conversation" style={{ height: "100dvh" }}><Logo size={44} /><h2>We could not open this conversation.</h2><p>Try loading it again.<br />Your local database has not been cleared.</p><Button onClick={reset}>Try again</Button></main>;
}
