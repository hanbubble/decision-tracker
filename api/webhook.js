const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SLACK_HEADERS = () => ({
  Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
});

// 채널 메시지 + 스레드 답글 모두 커버 (reactions.get 기반)
async function fetchAnyMessage(channel, ts) {
  // reactions.get으로 반응 달린 메시지 직접 조회 (thread_ts 포함)
  const r = await fetch(
    `https://slack.com/api/reactions.get?channel=${channel}&timestamp=${ts}&full=true`,
    { headers: SLACK_HEADERS() }
  );
  const d = await r.json();
  if (!d.ok) {
    console.error('reactions.get error:', d.error, '| needed:', d.needed);
    return null;
  }
  const msg = d.message;
  if (!msg) return null;

  // 채널 메시지이거나 스레드 루트면 바로 반환
  if (!msg.thread_ts || msg.thread_ts === msg.ts) return msg;

  // 스레드 답글이면 conversations.replies로 정확한 메시지 가져오기
  const r2 = await fetch(
    `https://slack.com/api/conversations.replies?channel=${channel}&ts=${msg.thread_ts}&latest=${ts}&inclusive=true&limit=1`,
    { headers: SLACK_HEADERS() }
  );
  const d2 = await r2.json();
  if (!d2.ok) { console.error('replies error:', d2.error); return msg; }
  return d2.messages?.find(m => m.ts === ts) || msg;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true });
  }

  const source = req.query.source;
  const body = req.body;
  console.log('[DEBUG] method:', req.method, 'source:', source, 'body:', JSON.stringify(body).slice(0, 200));

  // ── Slack ──────────────────────────────────────────────────────────────
  if (source === 'slack') {
    if (body.type === 'url_verification') {
      return res.status(200).json({ challenge: body.challenge });
    }

    const event = body.event;
    if (event?.type !== 'reaction_added') {
      return res.status(200).json({ ok: true });
    }

    const channel = event.item?.channel;
    const ts = event.item?.ts;

    // ── ❓ 질문 등록 ────────────────────────────────────────────────────
    if (event.reaction === 'question') {
      const { data: dup } = await supabase.from('qa_items').select('id').eq('slack_channel', channel).eq('slack_ts', ts).limit(1);
      if (dup && dup.length > 0) {
        console.log('Q&A already exists for ts:', ts);
      } else {
        let question = '(슬랙 메시지 내용을 가져오지 못했습니다)';
        try {
          const msg = await fetchAnyMessage(channel, ts);
          if (msg?.text) question = msg.text;
        } catch (e) {
          console.error('Slack fetch error:', e);
        }

        // 첫 줄에서 화면명 추출: "[... | #01.홈화면 ]" 형식에서 # 뒤 텍스트
        let screenId = null;
        const firstLine = question.split('\n')[0];
        const screenMatch = firstLine.match(/#([^\]|]+)/);
        if (screenMatch) {
          const screenName = screenMatch[1].trim();
          console.log('[Q] Extracted screen name:', screenName);
          try {
            const { data: screenRows } = await supabase
              .from('screens')
              .select('id')
              .ilike('name', screenName)
              .limit(1);
            if (screenRows?.[0]) {
              screenId = screenRows[0].id;
              console.log('[Q] Mapped to screen_id:', screenId);
            } else {
              console.log('[Q] No screen matched for:', screenName);
            }
          } catch (e) {
            console.error('[Q] Screen lookup error:', e);
          }
        }

        const insertPayload = {
          question,
          status: 'open',
          source: 'slack',
          slack_channel: channel,
          slack_ts: ts,
          source_author: event.user,
          source_url: `https://slack.com/archives/${channel}/p${ts?.replace('.', '')}`,
        };
        if (screenId) insertPayload.screen_id = screenId;

        const { error } = await supabase.from('qa_items').insert(insertPayload);
        if (error) console.error('Insert error:', error);
        else console.log('Q&A question saved:', question.slice(0, 60), screenId ? `→ screen ${screenId}` : '(no screen)');
      }
    }

    // ── 🔖 전달사항 등록 ────────────────────────────────────────────────
    if (event.reaction === 'bookmark') {
      const { data: dup } = await supabase.from('qa_items').select('id').eq('slack_channel', channel).eq('slack_ts', ts).limit(1);
      if (dup && dup.length > 0) {
        console.log('[Notice] Already exists for ts:', ts);
      } else {
        let question = '(슬랙 메시지 내용을 가져오지 못했습니다)';
        try {
          const msg = await fetchAnyMessage(channel, ts);
          if (msg?.text) question = msg.text;
        } catch (e) {
          console.error('[Notice] Slack fetch error:', e);
        }
        const { error } = await supabase.from('qa_items').insert({
          question,
          status: 'open',
          item_type: 'notice',
          source: 'slack',
          slack_channel: channel,
          slack_ts: ts,
          source_author: event.user,
          source_url: `https://slack.com/archives/${channel}/p${ts?.replace('.', '')}`,
        });
        if (error) console.error('[Notice] Insert error:', error);
        else console.log('[Notice] Saved:', question.slice(0, 60));
      }
    }

    // ── 🅰️ 답변 업데이트 ─────────────────────────────────────────────
    if (event.reaction === 'a') {
      let answerText = '';
      let parentTs = ts;

      try {
        const msg = await fetchAnyMessage(channel, ts);
        console.log('[A] msg ok:', !!msg, 'text:', msg?.text?.slice(0, 40), 'thread_ts:', msg?.thread_ts, 'ts:', msg?.ts);
        if (msg?.text) answerText = msg.text;
        if (msg?.thread_ts && msg.thread_ts !== msg.ts) {
          parentTs = msg.thread_ts;
        }
      } catch (e) {
        console.error('[A] Slack fetch error:', e);
      }

      console.log('[A] answerText len:', answerText.length, 'parentTs:', parentTs);

      if (!answerText) {
        console.error('[A] No answer text — skipping update. Check Slack bot token scope (channels:history)');
      } else {
        const { data: rows, error: selErr } = await supabase
          .from('qa_items')
          .select('id, answers')
          .eq('slack_channel', channel)
          .eq('slack_ts', parentTs)
          .limit(1);

        if (selErr) console.error('[A] Select error:', selErr);
        const existing = rows?.[0] || null;

        if (!existing) {
          console.error('[A] Q&A not found for ts:', parentTs, 'channel:', channel);
        } else {
          const currentAnswers = Array.isArray(existing.answers) ? existing.answers : [];
          const alreadySaved = currentAnswers.some(a => a.slack_ts === ts);
          console.log('[A] currentAnswers:', currentAnswers.length, 'alreadySaved:', alreadySaved);

          if (alreadySaved) {
            console.log('[A] Already recorded for ts:', ts);
          } else {
            const updatedAnswers = [...currentAnswers, {
              text: answerText,
              author: event.user,
              slack_ts: ts,
              created_at: new Date().toISOString(),
            }];
            // answers 배열 + legacy answer 필드 동시 업데이트
            const { error } = await supabase
              .from('qa_items')
              .update({ answers: updatedAnswers, answer: answerText, status: 'resolved', resolved_at: new Date().toISOString() })
              .eq('id', existing.id);
            if (error) {
              console.error('[A] Update with answers failed:', error, '— retrying with answer only');
              const { error: err2 } = await supabase
                .from('qa_items')
                .update({ answer: answerText, status: 'resolved', resolved_at: new Date().toISOString() })
                .eq('id', existing.id);
              if (err2) console.error('[A] Fallback update error:', err2);
              else console.log('[A] Fallback answer saved:', answerText.slice(0, 60));
            } else {
              console.log('[A] Answer appended:', answerText.slice(0, 60));
            }
          }
        }
      }
    }

    return res.status(200).json({ ok: true });
  }

  // ── Figma ──────────────────────────────────────────────────────────────
  if (source === 'figma') {
    const { event_type, file_key } = body;
    if (event_type !== 'FILE_COMMENT' && event_type !== 'COMMENT') {
      return res.status(200).json({ ok: true });
    }

    const commentParts = Array.isArray(body.comment) ? body.comment : [];
    const msg = commentParts.map(p => p.text || '').join('');
    const hasMention = commentParts.some(p => p.mention);
    const nodeId = body.client_meta?.node_id || null;
    const parentId = body.parent_id || null;
    const commentId = body.comment_id;
    const author = body.triggered_by?.handle || body.triggered_by?.id;

    console.log('[Figma] parsed: parentId:', parentId, 'nodeId:', nodeId, 'hasMention:', hasMention, 'msg:', msg.slice(0, 60));

    async function findScreenByNode(nid) {
      if (!nid) return null;

      // 정확한 매칭
      const { data } = await supabase.from('screens').select('id').eq('figma_node_id', nid).limit(1);
      if (data?.[0]) return data[0].id;

      // 폴백: 코멘트 노드가 속한 프레임 찾기
      const token = process.env.FIGMA_ACCESS_TOKEN;
      if (!token || !file_key) return null;
      try {
        const { data: screens } = await supabase.from('screens').select('id, figma_node_id').not('figma_node_id', 'is', null);
        if (!screens?.length) return null;
        const ids = screens.map(s => s.figma_node_id).join(',');
        const r = await fetch(`https://api.figma.com/v1/files/${file_key}/nodes?ids=${encodeURIComponent(ids)}`, {
          headers: { 'X-Figma-Token': token },
        });
        const d = await r.json();
        function hasChild(node, id) {
          if (node.id === id) return true;
          return node.children?.some(c => hasChild(c, id)) ?? false;
        }
        for (const screen of screens) {
          const doc = d.nodes?.[screen.figma_node_id]?.document;
          if (doc && hasChild(doc, nid)) {
            console.log('[Figma] node', nid, '→ screen', screen.id);
            return screen.id;
          }
        }
      } catch (e) {
        console.error('[Figma] Screen lookup fallback error:', e);
      }
      return null;
    }

    async function fetchFigmaComments(fileKey) {
      const token = process.env.FIGMA_ACCESS_TOKEN;
      if (!token) { console.error('[Figma] FIGMA_ACCESS_TOKEN not set'); return []; }
      const r = await fetch(`https://api.figma.com/v1/files/${fileKey}/comments`, {
        headers: { 'X-Figma-Token': token },
      });
      const d = await r.json();
      return d.comments || [];
    }

    // Case 1: 최상위 코멘트 → 자동 등록 + 화면 매핑
    if (!parentId && nodeId) {
      const { data: dup } = await supabase.from('qa_items').select('id').eq('figma_comment_id', commentId).limit(1);
      if (!dup?.length) {
        const screenId = await findScreenByNode(nodeId);
        const { error } = await supabase.from('qa_items').insert({
          question: msg,
          status: 'open',
          source: 'figma',
          figma_comment_id: commentId,
          figma_node_id: nodeId,
          source_author: author,
          ...(screenId ? { screen_id: screenId } : {}),
        });
        if (error) console.error('[Figma] Insert error:', error);
        else console.log('[Figma] New QA:', msg.slice(0, 60), screenId ? `→ screen ${screenId}` : '(no screen)');
      }
    }

    // Case 2: 답글에 멘션 → 부모 코멘트 + 전체 스레드 수집
    if (parentId && hasMention) {
      try {
        const allComments = await fetchFigmaComments(file_key);
        const parent = allComments.find(c => c.id === parentId);
        if (!parent) {
          console.error('[Figma] Parent comment not found:', parentId);
          return res.status(200).json({ ok: true });
        }

        const replies = allComments
          .filter(c => c.parent_id === parentId)
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        const parentNodeId = parent.client_meta?.node_id || null;
        const screenId = await findScreenByNode(parentNodeId);

        const answersList = replies.map(r => ({
          text: r.message,
          author: r.user?.handle,
          figma_comment_id: r.id,
          created_at: r.created_at,
        }));

        const { data: dup } = await supabase.from('qa_items').select('id').eq('figma_comment_id', parent.id).limit(1);

        if (!dup?.length) {
          const { error } = await supabase.from('qa_items').insert({
            question: parent.message,
            status: replies.length > 0 ? 'resolved' : 'open',
            source: 'figma',
            figma_comment_id: parent.id,
            figma_node_id: parentNodeId,
            source_author: parent.user?.handle,
            answers: answersList,
            answer: replies[replies.length - 1]?.message || null,
            ...(screenId ? { screen_id: screenId } : {}),
          });
          if (error) console.error('[Figma] Thread insert error:', error);
          else console.log('[Figma] Thread collected:', parent.message.slice(0, 60), `(${replies.length} replies)`);
        } else {
          // 이미 존재 → 새 답글만 추가
          const existingId = dup[0].id;
          const { data: existingRow } = await supabase.from('qa_items').select('answers').eq('id', existingId).single();
          const currentAnswers = Array.isArray(existingRow?.answers) ? existingRow.answers : [];
          const savedIds = new Set(currentAnswers.map(a => a.figma_comment_id));
          const newReplies = answersList.filter(a => !savedIds.has(a.figma_comment_id));
          if (newReplies.length > 0) {
            const updated = [...currentAnswers, ...newReplies];
            const { error } = await supabase.from('qa_items')
              .update({ answers: updated, answer: replies[replies.length - 1]?.message })
              .eq('id', existingId);
            if (error) console.error('[Figma] Thread update error:', error);
            else console.log('[Figma] Thread updated with', newReplies.length, 'new replies');
          } else {
            console.log('[Figma] Thread already up to date');
          }
        }
      } catch (e) {
        console.error('[Figma] Thread collection error:', e);
      }
    }

    return res.status(200).json({ ok: true });
  }

  res.status(200).json({ ok: true });
};
