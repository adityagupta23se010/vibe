import {
  Body,
  CurrentUser,
  Delete,
  Get,
  JsonController,
  Param,
  Patch,
  Post,
  QueryParam,
  Authorized,
} from 'routing-controllers';
import {inject, injectable} from 'inversify';
import {WHITEBOARD_TYPES} from './types.js';
import {WhiteboardService} from './WhiteboardService.js';

@injectable()
@Authorized()
@JsonController('/whiteboard')
export class WhiteboardController {
  constructor(
    @inject(WHITEBOARD_TYPES.Service)
    private readonly service: WhiteboardService,
  ) {}

  @Post('/sessions')
  create(@CurrentUser() user: any, @Body() body: {name?: string}) {
    return this.service.create(user._id.toString(), body?.name);
  }

  @Get('/sessions/mine')
  mine(
    @CurrentUser() user: any,
    @QueryParam('limit') limit = 30,
    @QueryParam('offset') offset = 0,
  ) {
    return this.service.listMine(
      user._id.toString(),
      Number(limit),
      Number(offset),
    );
  }

  @Get('/sessions/:roomCode')
  get(@Param('roomCode') roomCode: string, @CurrentUser() user: any) {
    return this.service.get(roomCode, user._id.toString());
  }

  @Patch('/sessions/:roomCode')
  async rename(
    @Param('roomCode') roomCode: string,
    @Body() body: {name: string},
    @CurrentUser() user: any,
  ) {
    await this.service.rename(roomCode, user._id.toString(), body.name);
    return {ok: true};
  }

  @Delete('/sessions/:roomCode')
  async remove(@Param('roomCode') roomCode: string, @CurrentUser() user: any) {
    await this.service.remove(roomCode, user._id.toString());
    return {ok: true};
  }

  @Get('/sessions/:roomCode/activity')
  activity(
    @Param('roomCode') roomCode: string,
    @CurrentUser() user: any,
    @QueryParam('after') after = 0,
    @QueryParam('limit') limit = 200,
  ) {
    return this.service.activity(
      roomCode,
      user._id.toString(),
      Number(after),
      Number(limit),
    );
  }
}
