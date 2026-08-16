/**
 * Public surface of the Waxwing design system (M1.1). Feature code imports base components from
 * this barrel rather than from a component file directly, so the inventory stays discoverable and
 * what feature code may depend on is exactly the list below.
 *
 * That is a convention, not an invariant: NOTHING enforces it — no lint rule, no import boundary,
 * no test. It happens to hold across `apps/web/src` right now (checked with
 * `grep -rn "from '\.\./ui/" apps/web/src` outside `src/ui/` itself, source and tests, one hit
 * which was moved onto the barrel), and it will stop holding the first time someone deep-imports
 * without noticing. Read the sentence above as the intent and this one as its actual standing.
 *
 * `src/ui/internal` is **not** private wholesale, and saying otherwise would misdescribe this
 * file: `Portal` and `useFocusTrap` are deliberately re-exported here (see the note at their
 * export). The rest of that directory — `cx`, `focusables`, `useDismiss` — has no importer
 * outside `src/ui/` and is not part of this surface.
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
export { useToolbarRoving } from './use-toolbar-roving'
export { VisuallyHidden, type VisuallyHiddenProps } from './VisuallyHidden'
