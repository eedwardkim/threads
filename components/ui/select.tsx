"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger className={cn("inline-flex h-8 items-center justify-between gap-2 rounded-full border border-border px-3 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40", className)} {...props}>
      {children}
      <SelectPrimitive.Icon asChild><ChevronDown size={13} className="text-muted-foreground" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content position="popper" sideOffset={7} className={cn("relative z-[70] min-w-44 overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl", className)} {...props}>
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item className={cn("relative flex w-full cursor-default select-none items-center rounded-lg py-2.5 pl-3 pr-8 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-4 items-center justify-center"><SelectPrimitive.ItemIndicator><Check size={14} /></SelectPrimitive.ItemIndicator></span>
    </SelectPrimitive.Item>
  );
}

function SelectGroup({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group className={cn("py-1", className)} {...props} />;
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn("px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground", className)} {...props} />;
}

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem, SelectGroup, SelectLabel };
