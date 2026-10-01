/**
 * Built-in viewer tools. Registered as a side effect of importing '@/core/viewer'.
 *  - select: click objects to select, drag on text to select text (popup), drag elsewhere = marquee.
 *  - hand:   drag to pan (Space temporarily pans with any tool).
 * Pointer behaviour for both lives in ViewerInteraction (they have no PageOverlay).
 */
import { Hand, MousePointer2 } from 'lucide-react';
import { registerTool } from '../registry';

export function registerViewerTools() {
  registerTool({ id: 'select', label: 'Select', icon: MousePointer2, group: 'select', shortcut: 'v', quick: 1, order: 0 });
  registerTool({ id: 'hand', label: 'Hand', icon: Hand, group: 'view', shortcut: 'h', quick: 2, order: 1, cursor: 'grab' });
}
