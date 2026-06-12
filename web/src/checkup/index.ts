/**
 * Entry point for the @polarcop/checkup-widget package.
 * Importing this module registers the <polar-checkup> custom element.
 */

export { PolarCheckup, registerPolarCheckup } from './PolarCheckup.js';
export type {
  AnnotationKind,
  Annotation,
  ArrowAnnotation,
  RectAnnotation,
  TextAnnotation,
  FreehandAnnotation,
} from './annotator.js';
export type { CaptureOptions, CaptureResult, ClipRect } from './screenshot.js';
export type { SubmitContext, SubmitResult } from './submitter.js';

import { registerPolarCheckup } from './PolarCheckup.js';
registerPolarCheckup();
