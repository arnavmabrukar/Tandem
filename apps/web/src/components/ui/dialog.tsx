import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { Button } from './button';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
  // When given, the header and this footer stay in view and only the body scrolls.
  footer?: ReactNode;
}) {
  const previousFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`dialog-content${footer ? ' dialog-structured' : ''}${className ? ` ${className}` : ''}`}
          onOpenAutoFocus={() => {
            previousFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (previousFocus.current?.isConnected) previousFocus.current.focus();
          }}
        >
          {footer ? (
            <>
              <div className="dialog-header">
                <div className="row between">
                  <Dialog.Title>{title}</Dialog.Title>
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="sm" aria-label="Close dialog">
                      <X size={18} />
                    </Button>
                  </Dialog.Close>
                </div>
                <Dialog.Description className="muted">{description}</Dialog.Description>
              </div>
              <div className="dialog-body">{children}</div>
              <div className="dialog-footer">{footer}</div>
            </>
          ) : (
            <>
              <div className="row between">
                <Dialog.Title>{title}</Dialog.Title>
                <Dialog.Close asChild>
                  <Button variant="ghost" size="sm" aria-label="Close dialog">
                    <X size={18} />
                  </Button>
                </Dialog.Close>
              </div>
              <Dialog.Description className="muted">{description}</Dialog.Description>
              {children}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
