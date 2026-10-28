import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ComponentProps } from 'react';

export const cn = (...values: ClassValue[]) => twMerge(clsx(values));
// Small shadcn-style primitive: source stays in the app so the team can change it.
const variants = cva(
  'button inline-flex items-center justify-center gap-2 rounded-md text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'button-primary',
        outline: 'button-outline',
        ghost: 'button-ghost',
        destructive: 'button-danger',
      },
      size: { default: 'h-10 px-4', sm: 'h-8 px-3 text-xs' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);
export function Button({
  asChild,
  variant,
  size,
  className,
  type = 'button',
  ...props
}: ComponentProps<'button'> & VariantProps<typeof variants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      type={asChild ? undefined : type}
      className={cn(variants({ variant, size }), className)}
      {...props}
    />
  );
}
