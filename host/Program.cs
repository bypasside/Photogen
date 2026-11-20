using System.Reflection;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Photogen;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

/// <summary>Window that hosts the web UI (embedded resources) inside WebView2.</summary>
internal sealed class MainForm : Form
{
    private const string Host = "photogen.local";
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Black };
    private readonly Assembly _asm = Assembly.GetExecutingAssembly();

    public MainForm()
    {
        Text = "Photogen";
        BackColor = Color.Black;
        MinimumSize = new Size(1000, 640);
        Size = new Size(1440, 900);
        StartPosition = FormStartPosition.CenterScreen;
        try { Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!); } catch { /* no icon */ }
        Controls.Add(_web);
        Load += async (_, _) => await InitAsync();
    }

    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    /// <summary>Black title bar: dark mode (attr 20) and caption/border colors on Windows 11 (attrs 34, 35, 36).</summary>
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int on = 1, black = 0x000000, border = 0x1E1E1E, text = 0xEDEDED;
        DwmSetWindowAttribute(Handle, 20, ref on, sizeof(int));
        DwmSetWindowAttribute(Handle, 35, ref black, sizeof(int));
        DwmSetWindowAttribute(Handle, 34, ref border, sizeof(int));
        DwmSetWindowAttribute(Handle, 36, ref text, sizeof(int));
    }

    private async Task InitAsync()
    {
        try
        {
            var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Photogen", "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            var r = MessageBox.Show(
                "Не найден компонент Microsoft Edge WebView2 Runtime, нужный для работы Photogen.\n\n" +
                "Открыть страницу загрузки?\n\n" + ex.Message,
                "Photogen", MessageBoxButtons.YesNo, MessageBoxIcon.Error);
            if (r == DialogResult.Yes)
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
                    "https://developer.microsoft.com/microsoft-edge/webview2/") { UseShellExecute = true });
            Close();
            return;
        }

        var core = _web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
#if DEBUG
        core.Settings.AreDevToolsEnabled = true;
#endif
        core.AddWebResourceRequestedFilter($"https://{Host}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnResource;
        core.WebMessageReceived += OnMessage;
        core.NewWindowRequested += (_, e) => e.Handled = true; // stay single-window
        core.Navigate($"https://{Host}/index.html");
    }

    /// <summary>Serves the embedded web files.</summary>
    private void OnResource(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var path = new Uri(e.Request.Uri).AbsolutePath.TrimStart('/');
        if (path.Length == 0) path = "index.html";
        var stream = _asm.GetManifestResourceStream("web/" + path);
        var env = _web.CoreWebView2.Environment;
        if (stream == null)
        {
            e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
            return;
        }
        var mime = Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".html" => "text/html; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".js" => "text/javascript; charset=utf-8",
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            _ => "application/octet-stream",
        };
        e.Response = env.CreateWebResourceResponse(stream, 200, "OK", $"Content-Type: {mime}\nCache-Control: no-cache");
    }

    /// <summary>Messages from the page: currently only {type:'save', name, data(base64)}.</summary>
    private void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.TryGetWebMessageAsString());
            var root = doc.RootElement;
            if (root.GetProperty("type").GetString() != "save") return;

            var name = root.GetProperty("name").GetString() ?? "file";
            var bytes = Convert.FromBase64String(root.GetProperty("data").GetString() ?? "");
            var ext = Path.GetExtension(name).TrimStart('.').ToLowerInvariant();

            using var dlg = new SaveFileDialog
            {
                FileName = name,
                Filter = $"{ext.ToUpperInvariant()} (*.{ext})|*.{ext}|Все файлы (*.*)|*.*",
                InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
                OverwritePrompt = true,
            };
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            File.WriteAllBytes(dlg.FileName, bytes);
            Reply(new { type = "saved", path = Path.GetFileName(dlg.FileName) });
        }
        catch (Exception ex)
        {
            Reply(new { type = "error", message = ex.Message });
        }
    }

    private void Reply(object msg) => _web.CoreWebView2.PostWebMessageAsString(JsonSerializer.Serialize(msg));
}
