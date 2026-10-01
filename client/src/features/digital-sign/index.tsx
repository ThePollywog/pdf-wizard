/**
 * Digital signatures with a CAC (Common Access Card): PAdES signatures written as incremental
 * updates (earlier signatures stay valid), signing existing empty signature fields or new ones,
 * and verification of the signatures in a document against the bundled DoD PKI trust list.
 *
 *  - task "digital-sign" (sign category), tool "digital-sign-place" (draw a new signature field)
 *  - right-rail panel "signatures" (order 70): validity of every signature in the document
 *  - page layer: clickable "Sign here" over empty signature fields while the task is open
 *  - the private-key operation goes through the PDF Wizard CAC extension + native helper (bridge.ts)
 */
import { FileSignature, SquareDashedMousePointer } from 'lucide-react';
import { registerCommands, registerPageLayer, registerPanel, registerTask, registerTool } from '@/core/registry';
import { actions } from '@/core/store';
import { clearTestSigner, enableTestSigner } from './bridge';
import { PANEL_ID, TASK_ID, TOOL_PLACE, useSigStore } from './model';
import { DigitalSignPanel, SignaturesRailPanel } from './Panel';
import { PlaceOverlay, SignHereLayer } from './layer';
import { openSignDialog } from './SignDialog';
import { verifyDocument } from './sign';
import './styles.css';

registerTool({
  id: TOOL_PLACE,
  label: 'Draw a signature field',
  icon: SquareDashedMousePointer,
  group: 'fill-sign',
  order: 50,
  cursor: 'crosshair',
  oneShot: true,
  PageOverlay: PlaceOverlay,
});

registerTask({
  id: TASK_ID,
  label: 'Digitally sign (CAC)',
  description: 'Sign with your Common Access Card and check the signatures in a PDF.',
  icon: FileSignature,
  color: '#1f4e79',
  category: 'sign',
  order: 0,
  featured: 1,
  keywords: ['cac', 'smart card', 'piv', 'digital signature', 'certificate', 'pki', 'dod', 'sign', 'signature', 'verify', 'validate', 'pades'],
  requiresDocument: true,
  Panel: DigitalSignPanel,
  toolbar: [TOOL_PLACE],
});

registerPanel({
  id: PANEL_ID,
  label: 'Signatures',
  icon: FileSignature,
  order: 70,
  Component: SignaturesRailPanel,
  badge: (doc) => useSigStore.getState().docs[doc.id]?.reports?.length || undefined,
});

registerPageLayer({ id: 'digital-sign-here', order: 40, placement: 'over-objects', Component: SignHereLayer });

registerCommands([
  {
    id: 'digital-sign.sign',
    label: 'Sign with CAC…',
    icon: FileSignature,
    menu: 'tools',
    group: '1-sign',
    order: 0,
    requiresDocument: true,
    run: () => actions.openTask(TASK_ID),
  },
]);

// Development hooks (the e2e suite signs with a throwaway software certificate).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__digitalSign = { enableTestSigner, clearTestSigner, openSignDialog, verifyDocument };
}
