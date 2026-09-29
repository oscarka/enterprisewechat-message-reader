import re

target_file = '/Users/cc/mini-health/src/components/demo/PremiumTabDemos.tsx'

with open(target_file, 'r', encoding='utf-8') as f:
    content = f.read()

helper_code = '''
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
'''

target_advisor_decl = 'export const PremiumAdvisorDemo: React.FC = () => {'
assert target_advisor_decl in content, 'target_advisor_decl not found'
content = content.replace(target_advisor_decl, helper_code + '\n' + target_advisor_decl, 1)

old_mock_start = '{messages.length === 0 && ('
old_mock_end = '        {/* 动态追加的用户与AI消息 (含各类 AI 自治动作执行回执卡片) */}'
assert old_mock_start in content, 'old_mock_start not found'
assert old_mock_end in content, 'old_mock_end not found'

start_idx = content.find(old_mock_start)
end_idx = content.find(old_mock_end)

new_empty_state = '''{messages.length === 0 && (
          <div className="space-y-3">
            <div className="flex justify-start">
              <div className="bg-white rounded-3xl rounded-tl-xs p-4 border border-slate-100 shadow-2xs max-w-[95%] space-y-2.5">
                <div className="flex items-center gap-2 pb-2 border-b border-slate-100 text-xs font-bold text-slate-800">
                  <Sparkles className="w-4 h-4 text-emerald-600" />
                  <span>专属健康顾问已接入</span>
                  <span className="text-[10px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full ml-auto font-medium">
                    7×24h 在线守护
                  </span>
                </div>
                <div className="text-xs text-slate-700 leading-relaxed">
                  您好，{currentMember?.name || '您'}！我是您的微健管专属健康顾问。
                  {isFracture
                    ? '已为您接入骨折术后康复专属档案。您可以随时向我咨询伤口消肿、拐杖使用、早期康复锻炼及复查注意事项。请问今天身体感觉如何？'
                    : '已为您接入慢病健康管理专属档案。您可以随时向我咨询血压监测、用药建议、低盐饮食搭配及日常健康疑问。请问今天量血压了吗？'}
                </div>
                <div className="pt-2 border-t border-slate-50">
                  <div className="text-[10px] font-bold text-slate-400 mb-2 flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-emerald-600" />
                    <span>快捷咨询胶囊（点击直接向管家提问）：</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {(isFracture ? [
                      '大夫，我脚踝骨折术后第14天拆线了，局部稍微有点肿胀，可以尝试双拐下地轻微负重吗？',
                      '伤口敷料边缘稍微有点淡黄色清亮渗液，周围皮肤微红，请问这算感染吗？',
                      '老人住在4楼无电梯，下周要去医院复查拆线，腿完全不敢接地，怎么下楼啊？'
                    ] : [
                      '管家，我最近晨起后颈发紧，刚测了血压 142/92，需要调整用药或者做动态心电吗？',
                      '隐形高钠调味品有哪些容易踩坑？',
                      '如何规范测量清晨血压与避免假性升高？'
                    ]).map((q, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => handleSend(q)}
                        className="text-left text-[11.5px] text-slate-700 hover:text-emerald-800 bg-slate-50 hover:bg-emerald-50/80 border border-slate-200/80 hover:border-emerald-200 p-2 rounded-xl transition-all cursor-pointer flex items-center gap-1.5 active:scale-98"
                      >
                        <span className="text-emerald-600 font-bold shrink-0">💊</span>
                        <span>{q}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        '''

content = content[:start_idx] + new_empty_state + content[end_idx:]

old_render = '<div className="whitespace-pre-line">{msg.text}</div>'
new_render = '''{msg.sender === 'ai' ? (
                renderFormattedMessage(msg.text)
              ) : (
                <div className="whitespace-pre-line">{msg.text}</div>
              )}'''
assert old_render in content, 'old_render not found'
content = content.replace(old_render, new_render, 1)

with open(target_file, 'w', encoding='utf-8') as f:
    f.write(content)

print('Successfully patched PremiumTabDemos.tsx!')
