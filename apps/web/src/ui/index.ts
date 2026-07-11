/**
 * Public surface of the Waxwing design system (M1.1). Feature code imports base components
 * from `@/ui` (this barrel), never from a component file directly, so the inventory stays
 * discoverable and the internal primitives (src/ui/internal) remain private.
 */

export { Avatar, type AvatarProps, type AvatarSize, initialsFromName } from './Avatar'
export { Badge, type BadgeProps, type BadgeTone } from './Badge'
export {
  Button,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from './Button'
export { Checkbox, type CheckboxProps } from './Checkbox'
export { Dialog, type DialogProps, type DialogSize } from './Dialog'
export { IconButton, type IconButtonProps } from './IconButton'
// Overlay primitives — shared by Dialog and the composer windows (M2.2), which are legitimate
// portal/focus-trapped surfaces of their own.
export { Portal } from './internal/Portal'
export { useFocusTrap } from './internal/useFocusTrap'
export { Menu, type MenuItemSpec, type MenuProps } from './Menu'
export { Select, type SelectProps } from './Select'
export { Skeleton, type SkeletonProps } from './Skeleton'
export { Spinner, type SpinnerProps, type SpinnerSize } from './Spinner'
export { type SplitOrientation, SplitPane, type SplitPaneProps } from './SplitPane'
export { Switch, type SwitchProps } from './Switch'
export { TextInput, type TextInputProps } from './TextInput'
export {
  type ToastOptions,
  ToastProvider,
  type ToastTone,
  useToast,
} from './Toast'
export { Tooltip, type TooltipPlacement, type TooltipProps } from './Tooltip'
export { VisuallyHidden, type VisuallyHiddenProps } from './VisuallyHidden'
