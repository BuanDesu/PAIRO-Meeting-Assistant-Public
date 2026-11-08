# Isolated foreground fixture: SendInput is permitted only while this form owns focus.
$ErrorActionPreference = 'Stop'
$assemblies = @('System.Windows.Forms', 'System.Drawing', 'System.Web.Extensions', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase')
foreach ($assembly in $assemblies) { Add-Type -AssemblyName $assembly }
$workerSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../electron/text-worker.cs'), [Text.Encoding]::UTF8)
$fixture = @'
public static class PairoAnswerFixture {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr value);
    [DllImport("user32.dll")] static extern short GetKeyState(int key);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static Form form;
    static RichTextBox box, other;
    static TextBox password;
    static int enter, pageDown;
    static void Reply(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static void Keys(params int[] triples) {
        if (GetForegroundWindow() != form.Handle || !form.ContainsFocus) throw new Exception("Fixture lost foreground; no input injected");
        // Share only the Win32 input struct and wrapper, never run the in-process hook/worker.
        var key = typeof(PairoTextWorker).GetMethod("Key", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
        var keys = Array.CreateInstance(key.ReturnType, triples.Length / 3);
        for (int i = 0; i < triples.Length; i += 3) keys.SetValue(key.Invoke(null, new object[] { (ushort)triples[i], (ushort)triples[i+1], (uint)triples[i+2] }), i/3);
        typeof(PairoTextWorker).GetMethod("Send", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic).Invoke(null, new object[] { keys });
    }
    static object Command(string action) {
        if (action == "reset") { box.ReadOnly = false; box.Clear(); other.Clear(); password.Clear(); enter = pageDown = 0; form.ActiveControl = box; box.Focus(); }
        else if (action == "other") { form.ActiveControl = other; other.Focus(); }
        else if (action == "password") { form.ActiveControl = password; password.Focus(); }
        else if (action == "readonly") { box.ReadOnly = true; form.ActiveControl = box; box.Focus(); }
        else if (action == "scan") Keys(0,0x2a,8, 0,0x51,8, 0,0x51,10, 0,0x2a,10);
        else if (action == "virtual") Keys(0x10,0,0, 0x63,0,0, 0x63,0,2, 0x10,0,2);
        else if (action == "page-down") Keys(0,0x2a,8, 0,0x51,9, 0,0x51,11, 0,0x2a,10);
        else if (action == "esc") Keys(0x1b,0,0, 0x1b,0,2);
        else if (action != "state") throw new Exception("Unknown fixture command");
        return new { foreground = GetForegroundWindow() == form.Handle, focus = box.Focused ? "primary" : other.Focused ? "secondary" : password.Focused ? "password" : "none", numLock = (GetKeyState(0x90) & 1) != 0,
            text = box.Text, other = other.Text, passwordLength = password.TextLength, enter = enter, pageDown = pageDown };
    }
    public static void Run() {
        IntPtr previous = GetForegroundWindow();
        form = new Form { Text = "PAIRO - generated answer typing fixture", Width = 520, Height = 210, TopMost = true };
        box = new RichTextBox { Dock = DockStyle.Top, Height = 90, AcceptsTab = false };
        other = new RichTextBox { Dock = DockStyle.Top, Height = 35 };
        password = new TextBox { Dock = DockStyle.Bottom, UseSystemPasswordChar = true };
        form.Controls.Add(other); form.Controls.Add(box); form.Controls.Add(password);
        foreach (Control target in new Control[] { box, other, password }) target.KeyDown += (sender,e) => {
            if (e.KeyCode == KeysEnum.Enter) enter++; if (e.KeyCode == KeysEnum.Next) pageDown++;
        };
        form.Shown += (sender, e) => {
            form.Activate(); box.Focus();
            var input = new Thread(() => {
                Reply(new { ready = true });
                string line;
                while ((line = Console.ReadLine()) != null && line != "quit") {
                    try { Reply(form.Invoke(new Func<object>(() => Command(line)))); }
                    catch (Exception error) { Reply(new { error = error.GetBaseException().Message }); }
                }
                if (!form.IsDisposed) form.BeginInvoke(new Action(() => { if (GetForegroundWindow() == form.Handle) SetForegroundWindow(previous); form.Close(); }));
            });
            input.IsBackground = true; input.Start();
        };
        Application.Run(form);
    }
    // Avoid collision with the fixture's Keys method.
    static class KeysEnum { public const System.Windows.Forms.Keys Enter = System.Windows.Forms.Keys.Enter, Next = System.Windows.Forms.Keys.Next; }
}
'@
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition ($workerSource + "`n" + $fixture) -ReferencedAssemblies $assemblies
[PairoAnswerFixture]::Run()
