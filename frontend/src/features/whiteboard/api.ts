import { apiClient } from '@/lib/api-client';
import type { ActivityEntry, BoardSession, WhiteboardObject } from './types';

export const whiteboardApi = {
  create: async (name?: string) => (await apiClient.post<BoardSession>('/whiteboard/sessions', { name })).data,
  load: async (roomCode: string) =>
    (await apiClient.get<{ session: BoardSession; objects: WhiteboardObject[]; role: 'editor' | 'viewer'; isCreator: boolean }>(`/whiteboard/sessions/${roomCode}`)).data,
  mine: async () => (await apiClient.get<BoardSession[]>('/whiteboard/sessions/mine')).data,
  rename: async (roomCode: string, name: string) => apiClient.patch(`/whiteboard/sessions/${roomCode}`, { name }),
  remove: async (roomCode: string) => apiClient.delete(`/whiteboard/sessions/${roomCode}`),
  activity: async (roomCode: string, after = 0, limit = 500) =>
    (await apiClient.get<ActivityEntry[]>(`/whiteboard/sessions/${roomCode}/activity?after=${after}&limit=${limit}`)).data,
};
