import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, RefreshCw, RotateCcw, Upload, X } from 'lucide-react';
import {
  BACKUP_MAX_BYTES,
  type BackupFile,
  type BackupPreview,
  type HistoryBoundary,
} from '../../../packages/core/src/types';
import { api, post } from './api';
import { useHistoryMutations } from './history';
import { ErrorState, Loading, useToast } from './ui';
import { dateTime } from './data-management-utils';
import './management.css';

interface BackupFiles {
  directory: string | null;
  items: BackupFile[];
}
interface RestoreResult {
  restored: true;
  backupName?: string;
  backupDirectory?: string;
  boundary?: HistoryBoundary;
}
type RestoreTarget = { kind: 'upload'; name: string; data: unknown } | { kind: 'local'; name: string };
const message = (error: unknown) => (error instanceof Error ? error.message : '备份操作没有完成，请重试');
const fullDate = (value: string) => new Date(value).toLocaleString('zh-CN');
const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

export function BackupManager() {
  const backups = useQuery({
    queryKey: ['backup-files'],
    queryFn: ({ signal }) => api<BackupFiles>('/backup/files', { signal }),
  });
  const client = useQueryClient();
  const mutations = useHistoryMutations();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'restore' | ''>('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ target: RestoreTarget; summary: BackupPreview }>();
  const [restored, setRestored] = useState<RestoreResult>();
  const [showFiles, setShowFiles] = useState(false);
  const priorFocus = useRef<HTMLElement | null>(null);
  const previewOpen = Boolean(preview);

  useEffect(() => {
    if (!previewOpen || !dialog.current) return;
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.current.open) dialog.current.showModal();
    return () => {
      if (priorFocus.current?.isConnected) priorFocus.current.focus();
    };
  }, [previewOpen]);

  const loadPreview = async (target: RestoreTarget) => {
    if (busy) return;
    setBusy('preview');
    setError('');
    try {
      const summary =
        target.kind === 'upload'
          ? await post<BackupPreview>('/backup/preview', target.data)
          : await post<BackupPreview>(`/backup/files/${encodeURIComponent(target.name)}/preview`);
      setPreview({ target, summary });
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy('');
    }
  };
  const selectFile = async (selected: File) => {
    if (busy) return;
    setError('');
    if (selected.size > BACKUP_MAX_BYTES) {
      setError('备份文件不能超过 64 MB，请选择完整的 Sardina JSON 备份。');
      return;
    }
    if (!selected.size) {
      setError('这个备份文件是空的，请重新选择。');
      return;
    }
    setBusy('preview');
    try {
      const data: unknown = JSON.parse(await selected.text());
      const summary = await post<BackupPreview>('/backup/preview', data);
      setPreview({ target: { kind: 'upload', name: selected.name, data }, summary });
    } catch (error) {
      setError(
        error instanceof SyntaxError
          ? '备份文件不是有效的 JSON。当前资料未改变，请选择完整的备份文件。'
          : message(error),
      );
    } finally {
      setBusy('');
    }
  };
  const restore = async () => {
    if (!preview || busy) return;
    setBusy('restore');
    setError('');
    try {
      const result =
        preview.target.kind === 'upload'
          ? await post<RestoreResult>('/backup/restore', preview.target.data)
          : await post<RestoreResult>(`/backup/files/${encodeURIComponent(preview.target.name)}/restore`, {
              fingerprint: preview.summary.fingerprint,
            });
      await mutations.restored(result.boundary);
      await client.invalidateQueries();
      setRestored(result);
      setShowFiles(true);
      setPreview(undefined);
      toast(result.backupName ? '备份已恢复，原资料已自动备份' : '备份已恢复');
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy('');
    }
  };
  const closePreview = () => {
    if (busy !== 'restore') {
      setPreview(undefined);
      setError('');
    }
  };
  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast('备份目录已复制');
    } catch {
      setError('无法自动复制目录，可以选中下方路径手动复制。');
    }
  };

  return (
    <div className="backup-manager">
      <div
        className={`setting-row backup-drop-zone ${dragging ? 'dragging' : ''}`}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
            setDragging(!busy);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (busy) return;
          if (event.dataTransfer.files.length !== 1) {
            setError('请一次选择一个 JSON 备份文件。');
            return;
          }
          void selectFile(event.dataTransfer.files[0]);
        }}
      >
        <div>
          <h3>备份与恢复</h3>
          <p>
            {dragging
              ? '放开文件，先查看备份内容。'
              : '导出追番、观看进度和设置；恢复前先预览内容，也可以拖入 JSON 文件。'}
          </p>
        </div>
        <div className="button-row">
          <a className="button secondary small" href="/api/v1/backup" download="sardina-anime-backup.json">
            <Download size={15} aria-hidden="true" />
            导出备份
          </a>
          <button className="button secondary small" disabled={!!busy} onClick={() => file.current?.click()}>
            <Upload size={15} aria-hidden="true" />
            {busy === 'preview' ? '正在读取…' : '恢复备份'}
          </button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            aria-label="选择备份文件"
            disabled={!!busy}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) void selectFile(selected);
              event.target.value = '';
            }}
          />
        </div>
      </div>
      {!preview && error && (
        <div className="management-inline-error" role="alert">
          {error}
        </div>
      )}
      {restored && (
        <div className="backup-restored" role="status">
          <strong>当前资料已恢复。</strong>
          {restored.backupName ? (
            <>
              <span>替换前的资料保存在 {restored.backupName}。</span>
              {restored.backupDirectory && <code>{restored.backupDirectory}</code>}
              <button
                className="button secondary small"
                disabled={!!busy}
                onClick={() => void loadPreview({ kind: 'local', name: restored.backupName! })}
              >
                <RotateCcw size={15} aria-hidden="true" />
                恢复上一次资料
              </button>
            </>
          ) : (
            <span>当前环境没有可写入的资料目录，没有生成恢复前备份。</span>
          )}
        </div>
      )}
      <details
        className="backup-files"
        open={showFiles}
        onToggle={(event) => setShowFiles(event.currentTarget.open)}
      >
        <summary>
          恢复前自动备份{backups.data?.items.length ? `（最近 ${backups.data.items.length} 份）` : ''}
        </summary>
        {backups.isPending ? (
          <Loading label="正在读取本地备份…" />
        ) : backups.isError ? (
          <ErrorState error={backups.error} retry={() => void backups.refetch()} />
        ) : (
          <>
            <p className="muted">
              每次替换恢复前保存一份原资料。这里的备份同样按整库替换恢复，不会合并重复条目。
            </p>
            {backups.data.directory ? (
              <div className="backup-directory">
                <span>备份目录</span>
                <code>{backups.data.directory}</code>
                <button
                  className="icon-button"
                  aria-label="复制备份目录"
                  onClick={() => void copyPath(backups.data.directory!)}
                >
                  <Copy size={16} />
                </button>
              </div>
            ) : (
              <p className="muted">当前使用临时资料环境，没有持久化备份目录。</p>
            )}
            <button
              className="text-link"
              disabled={backups.isFetching}
              onClick={() => void backups.refetch()}
            >
              <RefreshCw size={14} aria-hidden="true" />
              刷新备份列表
            </button>
            {!backups.data.items.length ? (
              <p className="muted">还没有恢复前备份。第一次恢复资料时会自动创建。</p>
            ) : (
              <ul className="backup-file-list">
                {backups.data.items.map((item) => (
                  <li key={item.name}>
                    <div>
                      <strong>{dateTime(item.createdAt)}</strong>
                      <p>
                        {item.valid
                          ? `${item.libraryCount} 部追番 · ${item.historyCount} 条观看记录 · ${fileSize(item.bytes)}`
                          : `此文件暂不能恢复：${item.error || '备份内容损坏'}`}
                      </p>
                      <small>{item.name}</small>
                    </div>
                    <div className="button-row">
                      <a
                        className="button secondary small"
                        href={`/api/v1/backup/files/${encodeURIComponent(item.name)}`}
                        download={item.name}
                      >
                        <Download size={14} aria-hidden="true" />
                        下载
                      </a>
                      <button
                        className="button secondary small"
                        disabled={!!busy || !item.valid}
                        onClick={() => void loadPreview({ kind: 'local', name: item.name })}
                      >
                        预览并恢复
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </details>
      {preview && (
        <dialog
          ref={dialog}
          className="management-dialog"
          aria-labelledby="backup-preview-title"
          aria-describedby="backup-preview-description"
          onCancel={(event) => {
            event.preventDefault();
            closePreview();
          }}
          onClose={closePreview}
        >
          <div className="management-dialog-heading">
            <h2 id="backup-preview-title">确认恢复内容</h2>
            <button
              className="icon-button"
              aria-label="关闭备份预览"
              disabled={busy === 'restore'}
              onClick={closePreview}
            >
              <X size={19} />
            </button>
          </div>
          <p className="backup-preview-name">{preview.target.name}</p>
          <p className="muted">备份时间：{fullDate(preview.summary.exportedAt)}</p>
          <dl className="backup-preview-counts">
            <div>
              <dt>追番</dt>
              <dd>
                {preview.summary.libraryCount} 部<span>当前 {preview.summary.current.libraryCount} 部</span>
              </dd>
            </div>
            <div>
              <dt>观看记录</dt>
              <dd>
                {preview.summary.historyCount} 条<span>当前 {preview.summary.current.historyCount} 条</span>
              </dd>
            </div>
            <div>
              <dt>搜索记录</dt>
              <dd>{preview.summary.searchHistoryCount} 条</dd>
            </div>
            <div>
              <dt>来源配置</dt>
              <dd>{preview.summary.sourceCount} 个</dd>
            </div>
          </dl>
          <p id="backup-preview-description">
            将替换：{preview.summary.replace.join('、')}。追番与观看记录不会与当前资料合并。
          </p>
          <p className="muted">
            {backups.data?.directory
              ? '恢复前会自动备份当前资料，可在设置中预览并恢复上一次资料。正在播放的页面需要重新读取进度。'
              : '当前临时资料环境无法生成恢复前备份，请先导出当前资料后再继续。'}
          </p>
          {error && (
            <div className="management-inline-error" role="alert">
              {error}
              {preview.target.kind === 'local' && (
                <button
                  className="text-link"
                  disabled={!!busy}
                  onClick={() => void loadPreview(preview.target)}
                >
                  重新预览
                </button>
              )}
            </div>
          )}
          <div className="management-dialog-actions">
            <button
              className="button secondary"
              autoFocus
              disabled={busy === 'restore'}
              onClick={closePreview}
            >
              取消
            </button>
            <button className="button primary" disabled={!!busy} onClick={() => void restore()}>
              {busy === 'restore' ? '正在恢复…' : '确认替换并恢复'}
            </button>
          </div>
        </dialog>
      )}
    </div>
  );
}
