import {ContainerModule} from 'inversify';
import {whiteboardContainerModule} from './container.js';
import {sharedContainerModule} from '#root/container.js';
import {authContainerModule} from '#auth/container.js';
import {WhiteboardController} from './WhiteboardController.js';
export const whiteboardContainerModules: ContainerModule[] = [
  whiteboardContainerModule,
  sharedContainerModule,
  authContainerModule,
];
export const whiteboardModuleControllers: Function[] = [WhiteboardController];
export const whiteboardModuleValidators: Function[] = [];
export * from './types.js';
export * from './WhiteboardService.js';
export * from './WhiteboardGateway.js';
