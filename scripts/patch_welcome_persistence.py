import re

target_file = '/Users/cc/mini-health/src/components/demo/PremiumTabDemos.tsx'

with open(target_file, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. 确保 renderInlineText, renderFormattedMessage, getInitialAdvisorMessages 在 PremiumAdvisorDemo 上方
helpers_and_initial = '''
function renderInlineText(text: string): React.ReactNode[] {
  const parts = text.split(/(\\**.*?\\**)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={idx} className="font-semibold text-slate-900 bg-amber-50/70 px-0.5 rounded">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

function renderFormattedMessage(content: string): React.ReactNode {
  if (!content) return null;
  const clean = content.replace(/\\[(?:推荐追问|追问建议|快捷追问)\\][：:]\\s*.+$/m, '').trim();
  const lines = clean.split('\\n');
  const elements: React.ReactNode[] = [];
  let tipLines: string[] = [];
  let inTip = false;

  const flushTip = (key: string) => {
    if (tipLines.length === 0) return;
    const text = tipLines.join('\\n').trim();
    elements.push(
      <div key={key} className="my-2 p-3 bg-linear-to-br from-emerald-50/90 to-teal-50/70 border border-emerald-200/80 rounded-2xl text-emerald-950 shadow-2xs space-y-1">
        <div className="flex items-center gap-1.5 font-bold text-[11.5px] text-emerald-900 pb-1 border-b border-emerald-200/40">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
          <span>居家护理行动指南</span>
        </div>
        <div className="text-[11px] leading-relaxed space-y-0.5">
          {text.split('\\n').map((l, idx) => {
            const trimmed = l.replace(/^[-*•\\d.]+\\s*/, '').trim();
            if (!trimmed) return null;
            return (
              <div key={idx} className="flex items-start gap-1">
                <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0 mt-0.5" />
                <span>{renderInlineText(trimmed)}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
    tipLines = [];
    inTip = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (line.match(/^>\\s*\\[!TIP\\]/i)) {
      if (inTip) flushTip('tip_' + i);
      inTip = true;
      continue;
    }
    if (inTip) {
      if (line.startsWith('>')) {
        tipLines.push(line.replace(/^>\\s*/, ''));
        continue;
      } else if (line === '') {
        continue;
      } else {
        flushTip('tip_' + i);
      }
    }
    if (line.startsWith('### ') || line.startsWith('## ')) {
      elements.push(
        <div key={'h_' + i} className="mt-2.5 mb-1 font-bold text-[12px] text-slate-900 border-l-2.5 border-emerald-500 pl-2 flex items-center gap-1">
          <Sparkles className="w-3 h-3 text-emerald-600 shrink-0" />
          <span>{line.replace(/^#+\\s*/, '')}</span>
        </div>
      );
      continue;
    }
    const listMatch = line.match(/^([-*•]|\\d+\\.)\\s+(.+)$/);
    if (listMatch) {
      elements.push(
        <div key={'li_' + i} className="flex items-start gap-1.5 my-0.5 pl-1 text-[11.5px] text-slate-700">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
          <div className="flex-1">{renderInlineText(listMatch[2])}</div>
        </div>
      );
      continue;
    }
    if (line === '') {
      elements.push(<div key={'sp_' + i} className="h-1" />);
    } else {
      elements.push(
        <div key={'p_' + i} className="text-[11.5px] text-slate-700 my-0.5 leading-relaxed">
          {renderInlineText(line)}
        </div>
      );
    }
  }
  if (inTip) flushTip('tip_end');
  return <div>{elements}</div>;
}

function getInitialAdvisorMessages(member: any, carePlan: any): AdvisorChatMessage[] {
  const isFracture = carePlan?.diseaseType === 'fracture' || (member?.chronicConditions || []).some((c: string) => c.includes('骨折'));
  const cleanName = member?.name || '您';
  return [
    {
      id: 'welcome_' + (member?.id || 'self'),
      sender: 'ai',
      text: '您好，' + cleanName + '！我是您的微健管专属健康顾问。已为您接入' + (isFracture ? '骨折术后康复专属档案' : '慢病健康管理专属档案') + '。\\n\\n您可以随时向我咨询：' + (isFracture ? '伤口消肿、拐杖使用、早期康复锻炼及复查注意事项' : '血压监测、用药建议、低盐饮食搭配及日常健康疑问') + '。请问今天身体感觉如何？',
      suggestions: isFracture ? [
        '大夫，我脚踝骨折术后第14天拆线了，局部稍微有点肿胀，可以尝试双拐下地轻微负重吗？',
        '伤口敷料边缘稍微有点淡黄色清亮渗液，周围皮肤微红，请问这算感染吗？',
        '老人住在4楼无电梯，下周要去医院复查拆线，腿完全不敢接地，怎么下楼啊？'
      ] : [
        '管家，我最近晨起后颈发紧，刚测了血压 142/92，需要调整用药或者做动态心电吗？',
        '隐形高钠调味品有哪些容易踩坑？',
        '如何规范测量清晨血压与避免假性升高？'
      ]
    }
  ];
}
'''

target_decl = 'export const PremiumAdvisorDemo: React.FC = () => {'
assert target_decl in content, 'target_decl not found'
if 'function getInitialAdvisorMessages' not in content:
    content = content.replace(target_decl, helpers_and_initial + '\n' + target_decl, 1)

# 2. 修改 loadSavedMessages 默认返回初始欢迎语
old_load_saved = '''  const loadSavedMessages = (memberId: string): AdvisorChatMessage[] => {
    try {
      const saved = localStorage.getItem(`${STORAGE_PREFIX}premium_chat_${memberId}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.warn('Failed to parse saved chat messages for member', memberId, e);
    }
    return [];
  };'''

new_load_saved = '''  const loadSavedMessages = (memberId: string): AdvisorChatMessage[] => {
    try {
      const saved = localStorage.getItem(`${STORAGE_PREFIX}premium_chat_${memberId}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.warn('Failed to parse saved chat messages for member', memberId, e);
    }
    return getInitialAdvisorMessages(currentMember, activeCarePlan);
  };'''

assert old_load_saved in content, 'old_load_saved not found'
content = content.replace(old_load_saved, new_load_saved, 1)

# 3. 修改 loadCloudHistory 确保首条始终有欢迎语
old_cloud_sync = '''        setMessages(prev => {
          if (prev.length === 0 || mappedMessages.length >= prev.length) {
            try {
              localStorage.setItem(`${STORAGE_PREFIX}premium_chat_${currentMember.id}`, JSON.stringify(mappedMessages));
            } catch {}
            return mappedMessages;
          }
          return prev;
        });'''

new_cloud_sync = '''        setMessages(prev => {
          const initialWelcome = getInitialAdvisorMessages(currentMember, activeCarePlan)[0];
          const hasWelcome = mappedMessages.some(m => m.id.startsWith('welcome_'));
          const finalMessages = hasWelcome ? mappedMessages : [initialWelcome, ...mappedMessages];
          if (prev.length === 0 || finalMessages.length >= prev.length) {
            try {
              localStorage.setItem(`${STORAGE_PREFIX}premium_chat_${currentMember.id}`, JSON.stringify(finalMessages));
            } catch {}
            return finalMessages;
          }
          return prev;
        });'''

assert old_cloud_sync in content, 'old_cloud_sync not found'
content = content.replace(old_cloud_sync, new_cloud_sync, 1)

# 4. 修改 handleClearHistory 重置为初始欢迎语
old_clear = '''  const handleClearHistory = () => {
    try {
      localStorage.removeItem(`${STORAGE_PREFIX}premium_chat_${currentMember.id}`);
    } catch {}
    setMessages([]);
    showToast('已重置当前对话记录');
  };'''

new_clear = '''  const handleClearHistory = () => {
    const welcome = getInitialAdvisorMessages(currentMember, activeCarePlan);
    try {
      localStorage.setItem(`${STORAGE_PREFIX}premium_chat_${currentMember.id}`, JSON.stringify(welcome));
    } catch {}
    setMessages(welcome);
    showToast('已重置当前对话记录');
  };'''

assert old_clear in content, 'old_clear not found'
content = content.replace(old_clear, new_clear, 1)

# 5. 移除 {messages.length === 0 && ( ... )} 遮罩块，因为首条消息已永久常驻作为 messages[0]
start_marker = '{messages.length === 0 && ('
end_marker = '{/* 动态追加的用户与AI消息 (含各类 AI 自治动作执行回执卡片) */}'
assert start_marker in content, 'start_marker not found'
assert end_marker in content, 'end_marker not found'

start_pos = content.find(start_marker)
end_pos = content.find(end_marker)
content = content[:start_pos] + content[end_pos:]

# 6. 在 messages.map 的每条消息内部，如果 msg.id.startsWith('welcome_')，渲染专属顾问已接入徽章
# 并在 AI 消息处使用 renderFormattedMessage(msg.text)
old_msg_render_block = '''              {msg.imageUrl && (
                <div className="rounded-xl overflow-hidden mb-1.5 border border-black/10 max-w-[220px]">
                  <img src={msg.imageUrl} alt="uploaded media" className="w-full h-auto object-cover max-h-48" />
                </div>
              )}
              <div className="whitespace-pre-line">{msg.text}</div>'''

new_msg_render_block = '''              {msg.id.startsWith('welcome_') && (
                <div className="flex items-center gap-2 pb-2 border-b border-slate-100 text-xs font-bold text-slate-800 mb-2">
                  <Sparkles className="w-4 h-4 text-emerald-600" />
                  <span>专属健康顾问已接入</span>
                  <span className="text-[10px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full ml-auto font-medium">
                    7×24h 在线守护
                  </span>
                </div>
              )}
              {msg.imageUrl && (
                <div className="rounded-xl overflow-hidden mb-1.5 border border-black/10 max-w-[220px]">
                  <img src={msg.imageUrl} alt="uploaded media" className="w-full h-auto object-cover max-h-48" />
                </div>
              )}
              {msg.sender === 'ai' ? (
                renderFormattedMessage(msg.text)
              ) : (
                <div className="whitespace-pre-line">{msg.text}</div>
              )}'''

assert old_msg_render_block in content, 'old_msg_render_block not found'
content = content.replace(old_msg_render_block, new_msg_render_block, 1)

# 7. 优化快捷追问胶囊：如果是欢迎语胶囊，点击也可以直接填入并发送
# 原代码：onClick={() => setInputText(sug)} -> 保持 setInputText(sug)，且加上 cursor 样式
with open(target_file, 'w', encoding='utf-8') as f:
    f.write(content)

print('Successfully applied clean welcome persistence patch!')
