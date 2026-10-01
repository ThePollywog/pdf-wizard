/**
 * UI KIT public API — import from '@/core/ui'.
 * See docs/ARCHITECTURE.md → UI kit. Component CSS lives in client/src/styles/components.css.
 */
export { Button, IconButton, type ButtonProps, type ButtonSize, type ButtonVariant, type IconButtonProps } from './Button';
export { Tooltip, type TooltipProps } from './Tooltip';
export { Modal, ModalHostContext, type ModalProps } from './Modal';
export {
  Dropdown,
  Menu,
  showContextMenu,
  closeContextMenu,
  cleanMenu,
  ContextMenuHost,
  type DropdownProps,
  type MenuActionItem,
  type MenuEntry,
  type MenuHeader,
  type SubmenuItem,
} from './Menu';
export { Popover, type PopoverProps } from './Popover';
export {
  TextField,
  TextArea,
  NumberField,
  Select,
  Checkbox,
  Switch,
  Radio,
  RadioGroup,
  Slider,
  type TextFieldProps,
  type TextAreaProps,
} from './Fields';
export { DEFAULT_PALETTE, ColorPicker, ColorSwatchButton, normalizeHex, isLight } from './Color';
export { SegmentedControl, Tabs, Spinner, ProgressBar, EmptyState, Kbd, Divider, Toolbar, PanelHeader, FileDropZone } from './Misc';
export {
  confirmDialog,
  promptDialog,
  alertDialog,
  choiceDialog,
  type AlertDialogOptions,
  type ChoiceDialogOption,
  type ConfirmDialogOptions,
  type PromptDialogOptions,
} from './dialogs';
export { ModalHost, ToastHost, BusyOverlay, UIHosts } from './Hosts';
export { formatShortcut, matchShortcut, parseShortcut, shortcutParts, isPlainKeyShortcut, type KeyLike, type ParsedShortcut } from './shortcut';
export { useFloating, computePosition, type AnchorRect, type Placement, type Side } from './position';
export { useEscapeLayer, pushEscape, hasEscapeLayer, isEditableTarget, focusableElements } from './layers';
