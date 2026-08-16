"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Next.js already reports this to its own error overlay in dev; in
    // production this is the only place it surfaces server-side, so it's
    // worth a real console.error rather than staying silent.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center sm:px-6">
      <AlertTriangle className="size-10 text-muted-foreground" />
      <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-muted-foreground">
        That&apos;s on us, not you. Try again, or head back to the homepage.
      </p>
      <div className="flex items-center gap-3 pt-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" render={<Link href="/">Go home</Link>} />
      </div>
    </div>
  );
}
