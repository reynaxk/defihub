import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center sm:px-6">
      <Compass className="size-10 text-muted-foreground" />
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-muted-foreground">
        Nothing lives at this address — the protocol, chain, or page may have moved.
      </p>
      <div className="flex items-center gap-3 pt-2">
        <Button render={<Link href="/">Go home</Link>} />
        <Button variant="outline" render={<Link href="/protocols">Browse protocols</Link>} />
      </div>
    </div>
  );
}
