"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SettingsForm({ initialName, email }: { initialName: string; email: string }) {
  const [name, setName] = useState(initialName);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        toast.error("Couldn't save changes");
        return;
      }
      toast.success("Saved");
    } catch {
      // fetch itself rejecting (offline, DNS failure) rather than
      // resolving with a non-2xx response - without this catch, the
      // exception would skip setIsSubmitting(false) below entirely and
      // leave the button stuck on "Saving..." until a page reload.
      toast.error("Couldn't save changes - check your connection");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={email} disabled />
        <p className="text-xs text-muted-foreground">Alert notifications are sent to this address.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Display name</Label>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <Button type="submit" disabled={isSubmitting} className="w-fit">
        {isSubmitting ? "Saving..." : "Save changes"}
      </Button>
    </form>
  );
}
