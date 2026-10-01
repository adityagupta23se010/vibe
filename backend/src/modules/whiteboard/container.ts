import {ContainerModule} from 'inversify';
import {WHITEBOARD_TYPES} from './types.js';
import {WhiteboardRepository} from './WhiteboardRepository.js';
import {WhiteboardService} from './WhiteboardService.js';
import {WhiteboardController} from './WhiteboardController.js';
export const whiteboardContainerModule = new ContainerModule(options => {
  options
    .bind(WHITEBOARD_TYPES.Repository)
    .to(WhiteboardRepository)
    .inSingletonScope();
  options
    .bind(WHITEBOARD_TYPES.Service)
    .to(WhiteboardService)
    .inSingletonScope();
  options.bind(WhiteboardController).toSelf().inSingletonScope();
});
