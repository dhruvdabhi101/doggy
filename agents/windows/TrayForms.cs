using System.Drawing;
using System.Windows.Forms;

namespace DoggyAgent;

/// <summary>Server URL + email + password → /api/auth/login or /api/auth/signup.</summary>
public sealed class SignInForm : Form
{
    private readonly TextBox _server = new() { Dock = DockStyle.Fill };
    private readonly TextBox _email = new() { Dock = DockStyle.Fill };
    private readonly TextBox _password = new() { Dock = DockStyle.Fill, UseSystemPasswordChar = true };
    private readonly Button _signIn = new() { Text = "Sign in", AutoSize = true };
    private readonly Button _signUp = new() { Text = "Create account", AutoSize = true };
    private readonly Label _msg = new() { AutoSize = true, ForeColor = Color.Firebrick, MaximumSize = new Size(380, 0) };

    /// <summary>Raised on the UI thread after the token has been saved.</summary>
    public event Action? SignedIn;

    public SignInForm(string? server)
    {
        Text = "Sign in to Doggy";
        Icon = TrayApp.LoadIcon();
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(12);
        ShowInTaskbar = true;
        TopMost = true;

        _server.Text = string.IsNullOrWhiteSpace(server) ? TrayApp.DefaultServer : server;

        var grid = new TableLayoutPanel
        {
            ColumnCount = 2, AutoSize = true, Dock = DockStyle.Fill,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
        };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 280));
        AddRow(grid, "Server", _server);
        AddRow(grid, "Email", _email);
        AddRow(grid, "Password", _password);

        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Dock = DockStyle.Fill };
        buttons.Controls.Add(_signIn);
        buttons.Controls.Add(_signUp);
        grid.Controls.Add(_msg, 0, 3);
        grid.SetColumnSpan(_msg, 2);
        grid.Controls.Add(buttons, 0, 4);
        grid.SetColumnSpan(buttons, 2);
        Controls.Add(grid);

        AcceptButton = _signIn;
        _signIn.Click += async (_, _) => await SubmitAsync(signup: false);
        _signUp.Click += async (_, _) => await SubmitAsync(signup: true);
        Shown += (_, _) => (_email.Text.Length == 0 ? _email : _password).Focus();
    }

    private static void AddRow(TableLayoutPanel grid, string label, Control box)
    {
        int row = grid.RowCount++;
        grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(3, 7, 8, 3) }, 0, row);
        grid.Controls.Add(box, 1, row);
    }

    private async Task SubmitAsync(bool signup)
    {
        string server = _server.Text.Trim().TrimEnd('/');
        string email = _email.Text.Trim();
        string password = _password.Text;
        if (server.Length == 0 || email.Length == 0 || password.Length == 0)
        {
            _msg.Text = "Server, email and password are required.";
            return;
        }
        if (!Uri.TryCreate(server, UriKind.Absolute, out var uri) || (uri.Scheme != "https" && uri.Scheme != "http"))
        {
            _msg.Text = "Server must be a URL like https://doggy.ruv.world";
            return;
        }

        SetBusy(true);
        _msg.ForeColor = SystemColors.GrayText;
        _msg.Text = signup ? "Creating account…" : "Signing in…";
        try
        {
            var client = new ApiClient(server);
            string device = Environment.MachineName;
            var resp = signup
                ? await client.SignupAsync(email, password, device)
                : await client.LoginAsync(email, password, device);
            if (string.IsNullOrEmpty(resp.Token))
                throw new InvalidOperationException("server returned no token");

            var cfg = AgentConfig.Load() ?? new AgentConfig();
            cfg.Server = server;
            cfg.Token = resp.Token!;
            cfg.DeviceName = device;
            cfg.Save();

            SignedIn?.Invoke();
            Close();
        }
        catch (Exception ex)
        {
            _msg.ForeColor = Color.Firebrick;
            _msg.Text = ex.Message.Length > 300 ? ex.Message[..300] + "…" : ex.Message;
            SetBusy(false);
        }
    }

    private void SetBusy(bool busy)
    {
        _signIn.Enabled = _signUp.Enabled = _server.Enabled = _email.Enabled = _password.Enabled = !busy;
        UseWaitCursor = busy;
    }
}

/// <summary>Textbox → POST /api/notes {text, source:"text"}; shows extracted item titles.</summary>
public sealed class QuickNoteForm : Form
{
    private readonly ApiClient _api;
    private readonly TextBox _text = new()
    {
        Multiline = true, AcceptsReturn = true, ScrollBars = ScrollBars.Vertical,
        Dock = DockStyle.Fill, Height = 110,
    };
    private readonly Button _send = new() { Text = "Save note", AutoSize = true };
    private readonly Label _status = new() { AutoSize = true, ForeColor = SystemColors.GrayText };
    private readonly ListBox _items = new() { Dock = DockStyle.Fill, Height = 110, IntegralHeight = false };

    public QuickNoteForm(ApiClient api)
    {
        _api = api;
        Text = "Doggy — Quick note";
        Icon = TrayApp.LoadIcon();
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(440, 320);
        MinimumSize = new Size(360, 280);
        Padding = new Padding(10);
        TopMost = true;

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5 };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        layout.Controls.Add(new Label { Text = "What should Doggy remember? (Ctrl+Enter to save)", AutoSize = true }, 0, 0);
        layout.Controls.Add(_text, 0, 1);
        var row = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight };
        row.Controls.Add(_send);
        row.Controls.Add(_status);
        layout.Controls.Add(row, 0, 2);
        layout.Controls.Add(new Label { Text = "Extracted:", AutoSize = true }, 0, 3);
        layout.Controls.Add(_items, 0, 4);
        Controls.Add(layout);

        _send.Click += async (_, _) => await SendAsync();
        _text.KeyDown += async (_, e) =>
        {
            if (e.Control && e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await SendAsync(); }
        };
    }

    private async Task SendAsync()
    {
        string text = _text.Text.Trim();
        if (text.Length == 0) return;
        _send.Enabled = false;
        _text.ReadOnly = true;
        _status.ForeColor = SystemColors.GrayText;
        _status.Text = "Saving…";
        try
        {
            var resp = await _api.PostNoteAsync(text);
            _items.Items.Clear();
            foreach (var it in resp.Items)
                _items.Items.Add($"[{it.Type ?? "item"}] {it.Title}");
            if (resp.Items.Count == 0) _items.Items.Add("(nothing extracted — saved as a note)");
            _status.Text = "Saved.";
            _text.Clear();
        }
        catch (Exception ex)
        {
            _status.ForeColor = Color.Firebrick;
            _status.Text = ex.Message.Length > 120 ? ex.Message[..120] + "…" : ex.Message;
        }
        finally
        {
            _send.Enabled = true;
            _text.ReadOnly = false;
            _text.Focus();
        }
    }
}
