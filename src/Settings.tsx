import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, json } from "./api";
interface SettingsData {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  tldrawLicense: string;
}
export function Settings({ close }: { close: () => void }) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<SettingsData>("/api/settings")
      .then(setSettings)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="settings-modal"
      >
        <header>
          <h2 id="settings-title">模型设置</h2>
          <button aria-label="关闭模型设置" onClick={close}>
            <X size={18} />
          </button>
        </header>
        <p>
          配置 OpenAI
          兼容接口，用于当前课件问答。请求中的课件和对话会发送到所配置的模型服务。
        </p>
        {settings ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await api(
                  "/api/settings",
                  json("PUT", {
                    baseUrl: settings.baseUrl,
                    model: settings.model,
                    apiKey: key,
                  }),
                );
                close();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Base URL
              <input
                required
                type="url"
                placeholder="https://api.example.com/v1"
                value={settings.baseUrl}
                onChange={(e) =>
                  setSettings({ ...settings, baseUrl: e.target.value })
                }
              />
            </label>
            <label>
              模型名
              <input
                required
                placeholder="供应商提供的模型 ID"
                value={settings.model}
                onChange={(e) =>
                  setSettings({ ...settings, model: e.target.value })
                }
              />
            </label>
            <label>
              API Key
              <input
                required={!settings.hasKey}
                type="password"
                autoComplete="new-password"
                placeholder={
                  settings.hasKey
                    ? "已配置；留空保留现有密钥"
                    : "输入模型 API Key"
                }
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <small>密钥保存在部署电脑，页面不会读取已保存的密钥。</small>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <footer>
              <button type="button" onClick={close}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "保存中…" : "保存设置"}
              </button>
            </footer>
          </form>
        ) : (
          <p>{error || "正在读取设置…"}</p>
        )}
      </section>
    </div>
  );
}
