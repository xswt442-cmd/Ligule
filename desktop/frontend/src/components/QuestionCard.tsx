import { useState } from 'react';
import { useText } from '../locale';

export type QuestionOption = { label: string; description?: string };
export type Question = { id: string; question: string; header?: string; options: QuestionOption[]; multiSelect: boolean };
export type QuestionAsk = { id: string; sessionId: string; project: string; questions: Question[] };
/** 保存卡片中的已输入答案；关闭卡片时由父级写入会话记录。 */
export type QuestionDrafts = Record<string, { picked: string[]; extra: string }>;

const answered = (draft: { picked: string[]; extra: string }) => draft.picked.length > 0 || draft.extra.trim() !== '';

export function QuestionCard({ ask, queued, active, initialDrafts, onSubmit, onCancel, onOpen, onDraft }: {
  ask: QuestionAsk;
  queued: number;
  active: string | null;
  initialDrafts?: QuestionDrafts;
  onSubmit: (answers: { id: string; selected: string[]; custom?: string }[]) => void;
  onCancel: () => void;
  onOpen: (sessionId: string) => void;
  onDraft: (id: string, drafts: QuestionDrafts) => void;
}) {
  const t = useText();
  const [drafts, setDrafts] = useState<QuestionDrafts>(
    () => initialDrafts ?? Object.fromEntries(ask.questions.map((question) => [question.id, { picked: [], extra: '' }])),
  );
  const background = ask.sessionId !== active;
  const anyAnswered = ask.questions.some((question) => answered(drafts[question.id] ?? { picked: [], extra: '' }));
  const pick = (id: string, label: string, multiple: boolean) => {
    const draft = drafts[id] ?? { picked: [], extra: '' };
    const picked = multiple
      ? (draft.picked.includes(label) ? draft.picked.filter((one) => one !== label) : [...draft.picked, label])
      : [label];
    const next = { ...drafts, [id]: { ...draft, picked } };
    setDrafts(next);
    onDraft(ask.id, next);
  };
  const write = (id: string, extra: string) => {
    const next = { ...drafts, [id]: { ...(drafts[id] ?? { picked: [], extra: '' }), extra } };
    setDrafts(next);
    onDraft(ask.id, next);
  };
  const submit = () => {
    if (!anyAnswered) return;
    onSubmit(ask.questions
      .map((question) => {
        const draft = drafts[question.id] ?? { picked: [], extra: '' };
        return { id: question.id, selected: draft.picked, ...(draft.extra.trim() === '' ? {} : { custom: draft.extra.trim() }) };
      })
      .filter((answer) => answered({ picked: answer.selected, extra: answer.custom ?? '' })));
  };
  return <section className="question" aria-label={t('等待回答', 'Waiting for answers')}>
    <div className="question-body">
      <div className="question-head">
        <span className="question-kind">{background ? t('另一会话正在等待', 'Another session is waiting') : t('请回答', 'Your answer is needed')}</span>
        {ask.project !== '' && <span className="row-note">{t('项目', 'Project')} {ask.project}</span>}
        {queued > 0 && <span className="row-note">{t(`还有 ${queued} 条提问`, `${queued} more question(s)`)}</span>}
        {background && <button type="button" onClick={() => onOpen(ask.sessionId)}>{t('打开会话', 'Open session')} {ask.sessionId.slice(0, 8)}</button>}
      </div>
      {ask.questions.map((question, index) => {
        const draft = drafts[question.id] ?? { picked: [], extra: '' };
        return <fieldset className="question-item" key={question.id}>
          <legend>
            {index + 1}. {question.question}
            {question.header === undefined ? '' : <span className="question-tag">{question.header}</span>}
            {question.multiSelect && <span className="question-tag">{t('可多选', 'Select multiple')}</span>}
          </legend>
          {question.options.map((option) => <label className="question-option" key={option.label}>
            <input
              type={question.multiSelect ? 'checkbox' : 'radio'}
              name={question.id}
              checked={draft.picked.includes(option.label)}
              onChange={() => pick(question.id, option.label, question.multiSelect)}
            />
            <span>{option.label}</span>
            {option.description === undefined ? null : <span className="question-option-note">{option.description}</span>}
          </label>)}
          <input
            className="question-free"
            type="text"
            placeholder={t('或输入其他答案', 'Or enter another answer')}
            value={draft.extra}
            aria-label={t(`第 ${index + 1} 题的补充回答`, `Additional answer for question ${index + 1}`)}
            onChange={(event) => write(question.id, event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.key !== 'Enter') return;
              event.preventDefault();
              submit();
            }}
          />
        </fieldset>;
      })}
    </div>
    <div className="question-actions">
      <button type="button" data-tone="allow" disabled={!anyAnswered} onClick={submit}>{t('提交答案', 'Submit answers')}</button>
      <button type="button" data-tone="deny" onClick={onCancel}>{t('取消本轮', 'Cancel turn')}</button>
      <span className="question-note">{t('留空题目会标记为未回答；本轮会持续等待，直到提交或取消。', 'Blank questions are recorded as unanswered; the turn waits until you submit or cancel.')}</span>
    </div>
  </section>;
}
