/**
 * 对话路由 — POST /chat
 * 支持 SSE (Server-Sent Events) 流式响应
 */

import { Router, type Request, type Response } from 'express';
import type { AgentRuntime, StreamEvent } from '@zhonggui/agent-core';
import type { SessionId, UserId } from '@zhonggui/data';

export function createChatRouter(getRuntime: () => AgentRuntime): Router {
  const router = Router();

  /**
   * POST /chat
   * Body: { sessionId: string, userId: string, message: string, model?: string }
   *
   * 返回 SSE 流：
   *   event: stream_event
   *   data: { type, content, ... }
   *
   * 结束时：
   *   event: done
   *   data: [DONE]
   */
  router.post('/chat', async (req: Request, res: Response) => {
    let { sessionId, userId, message, model } = req.body;

    // 修复前端可能发送 "undefined" 字符串的情况
    if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
      sessionId = undefined;
    }
    if (!userId || userId === 'undefined' || userId === 'null') {
      userId = undefined;
    }

    if (!sessionId || !userId || !message) {
      res.status(400).json({
        error: 'Missing required fields: sessionId, userId, message',
      });
      return;
    }

    // 设置 SSE 响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 禁用 Nginx 缓冲
    });

    // 立即发送连接确认
    res.write(': connected\n\n');

    // 处理客户端断开
    let aborted = false;
    const controller = new AbortController();

    req.on('close', () => {
      aborted = true;
      controller.abort();
    });

    try {
      const runtime = getRuntime();
      const stream = runtime.chat(
        sessionId as SessionId,
        userId as UserId,
        message,
        controller.signal,
        model,
      );

      for await (const event of stream) {
        if (aborted) break;

        const sseData = `data: ${JSON.stringify(event)}\n\n`;
        res.write(sseData);

        // 如果是 done 或 error 事件，结束流
        if (event.type === 'done' || event.type === 'error') {
          break;
        }
      }
    } catch (err) {
      if (!aborted) {
        const errorEvent: StreamEvent = {
          type: 'error',
          content: '',
          message: err instanceof Error ? err.message : 'Unknown error',
        };
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      }
    } finally {
      if (!aborted) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  });

  return router;
}
