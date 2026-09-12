"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-[3px]" />
      <DialogPrimitive.Content className={cn("fixed left-1/2 top-[22%] z-[80] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-2xl focus:outline-none", className)} {...props}>
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-label="Close dialog">
          <X size={17} />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mb-5 flex flex-col gap-2 pr-6", className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-lg font-semibold", className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-sm leading-relaxed text-muted-foreground", className)} {...props} />;
}

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogDescription };
