using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Web.Script.Serialization;

// STA input worker: foreground-only, no content logging, no activation or window creation.
public static class PairoTextWorker {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] input, int size);
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT key; [FieldOffset(0)] public MOUSEINPUT mouse; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int x, y; public uint data, flags, time; public UIntPtr extra; }
    static IntPtr target;
    static AutomationElement focus;
    static string token;
    static DateTime armed;
    static int cancelEpoch, operationEpoch;
    static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 200000 };
    static readonly object outputLock = new object();
    static void Output(object value) { lock(outputLock) Console.WriteLine(new JavaScriptSerializer().Serialize(value)); }
    static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
    static bool Modifiers() { return Down(0x10) || Down(0x11) || Down(0x12) || Down(0x5b) || Down(0x5c); }
    static void Stable(IntPtr window, AutomationElement element) {
        if (operationEpoch != System.Threading.Volatile.Read(ref cancelEpoch)) throw new Exception("focus");
        if (window == IntPtr.Zero || GetForegroundWindow() != window || element == null || !Automation.Compare(element, AutomationElement.FocusedElement)) throw new Exception("focus");
    }
    static void ReleaseKeys(IntPtr window, AutomationElement element) {
        for (int i = 0; i < 100; i++) {
            Stable(window, element);
            if (!Modifiers() && !Down(0x63)) return;
            Thread.Sleep(20);
        }
        throw new Exception("modifiers");
    }
    static bool Editable(AutomationElement element) {
        if (element == null || !element.Current.IsEnabled || element.Current.IsPassword) return false;
        object pattern;
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return !((ValuePattern)pattern).Current.IsReadOnly;
        if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) {
            object readOnly = ((TextPattern)pattern).DocumentRange.GetAttributeValue(TextPattern.IsReadOnlyAttribute);
            return readOnly is bool && !(bool)readOnly;
        }
        return false;
    }
    static INPUT Key(ushort vk, ushort scan, uint flags) { return new INPUT { type = 1, data = new INPUTUNION { key = new KEYBDINPUT { vk = vk, scan = scan, flags = flags } } }; }
    static void Send(INPUT[] inputs) { if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new Exception("input"); }
    static string Selection() {
        IntPtr window = GetForegroundWindow();
        AutomationElement element = AutomationElement.FocusedElement;
        if (element == null || element.Current.IsPassword) throw new Exception("selection");
        ReleaseKeys(window, element);
        // Prefer UIA: selection is available without ever touching the clipboard.
        object pattern;
        if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) {
            var ranges = ((TextPattern)pattern).GetSelection();
            string text = "";
            foreach (var range in ranges) { text += range.GetText(12001); if (text.Length > 12000) break; }
            Stable(window, element);
            if (!String.IsNullOrWhiteSpace(text)) return text;
            throw new Exception("selection");
        }
        // Fallback for apps exposing Copy but not UIA text. Materialize every format before replacing it.
        var snapshot = new DataObject();
        try {
            var original = Clipboard.GetDataObject();
            if (original != null) foreach (string format in original.GetFormats(false)) {
                object data = original.GetData(format, false);
                if (data == null) throw new Exception("clipboard");
                var stream = data as System.IO.MemoryStream;
                if (stream != null) data = new System.IO.MemoryStream(stream.ToArray());
                else if (data is System.Drawing.Image) data = ((System.Drawing.Image)data).Clone();
                else if (!(data is string) && !(data is byte[]) && !(data is string[])) throw new Exception("clipboard");
                snapshot.SetData(format, false, data);
            }
        } catch { throw new Exception("clipboard"); }
        uint sequence = GetClipboardSequenceNumber(), copied = sequence;
        string result = null;
        try {
            Stable(window, element);
            Send(new [] { Key(0x11, 0, 0), Key(0x43, 0, 0), Key(0x43, 0, 2), Key(0x11, 0, 2) });
            for (int i = 0; i < 50; i++) {
                Stable(window, element);
                copied = GetClipboardSequenceNumber();
                if (copied != sequence) {
                    if (Clipboard.ContainsText(TextDataFormat.UnicodeText)) result = Clipboard.GetText(TextDataFormat.UnicodeText);
                    break;
                }
                Thread.Sleep(20);
            }
        } finally {
            // Do not overwrite a later user clipboard change.
            if (copied != sequence && GetClipboardSequenceNumber() == copied) {
                try { Clipboard.SetDataObject(snapshot, true); } catch { /* A clipboard owner can refuse restoration. */ }
            }
        }
        if (String.IsNullOrWhiteSpace(result)) throw new Exception("selection");
        return result;
    }
    static object Execute(Dictionary<string, object> command) {
        string action = (string)command["action"];
        if (action == "bindings") { PairoNumpadHook.Configure((object[])command["bindings"]); return new { configured = true }; }
        if (action == "copy") return new { text = Selection() };
        if (action == "arm") {
            target = GetForegroundWindow(); focus = AutomationElement.FocusedElement;
            if (!Editable(focus)) throw new Exception("target");
            ReleaseKeys(target, focus);
            token = Guid.NewGuid().ToString("N"); armed = DateTime.UtcNow;
            return new { token = token };
        }
        if (action != "type" || token == null || (string)command["token"] != token || (DateTime.UtcNow - armed).TotalSeconds > 10) throw new Exception("expired");
        token = null; // single use, including on failure
        string textValue = (string)command["text"];
        int chinese = Convert.ToInt32(command["chineseCpm"]), english = Convert.ToInt32(command["englishWpm"]);
        if (textValue.Length > 24000 || chinese < 10 || chinese > 600 || english < 10 || english > 300) throw new Exception("input");
        ReleaseKeys(target, focus);
        int count = 0;
        // Use spaces for line breaks: Unicode LF is dropped by many edit controls;
        // VK_RETURN or a CR character could submit the user's form.
        textValue = textValue.Replace("\r\n", " ").Replace('\r', ' ').Replace('\n', ' ').Replace('\t', ' ');
        var clock = System.Diagnostics.Stopwatch.StartNew();
        long due = 0;
        for (int index = 0; index < textValue.Length; index++) {
            char ch = textValue[index];
            if (Char.IsControl(ch) && ch != '\n') continue;
            bool cjk = ch >= 0x2e80 && ch <= 0x9fff || ch >= 0xf900 && ch <= 0xfaff || Char.IsSurrogate(ch);
            int delay = (int)Math.Ceiling(60000.0 / (cjk ? chinese : english * 5));
            due += delay;
            // Wait before each character, including the first, leaving time to cancel.
            while (clock.ElapsedMilliseconds < due) {
                Stable(target, focus);
                // Shift is allowed here so pressing the first half of Shift+Num3
                // cannot finish cancellation before the complete toggle chord arrives.
                if (Down(0x1b) || Down(0x11) || Down(0x12) || Down(0x5b) || Down(0x5c)) throw new Exception("focus");
                int remaining = (int)Math.Min(20, due - clock.ElapsedMilliseconds);
                if (remaining > 0) Thread.Sleep(remaining);
            }
            Stable(target, focus);
            if (!Editable(focus)) throw new Exception("target");
            string character = ch.ToString();
            if (Char.IsHighSurrogate(ch) && index + 1 < textValue.Length && Char.IsLowSurrogate(textValue[index + 1])) character += textValue[++index];
            var keys = new List<INPUT>();
            foreach (char unit in character) { keys.Add(Key(0, unit, 4)); keys.Add(Key(0, unit, 6)); }
            // UIA's editable check can call into a slow application. Recheck focus after it,
            // immediately before handing this single character to the Windows input queue.
            Stable(target, focus);
            Send(keys.ToArray()); count++;
        }
        return new { count = count };
    }
    public static void Run() {
        PairoNumpadHook.Start(action => Output(new { shortcut = action }));
        var commands = new System.Collections.Concurrent.BlockingCollection<Tuple<Dictionary<string, object>, int>>();
        var reader = new Thread(() => {
            try {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    try {
                        var command = new JavaScriptSerializer { MaxJsonLength = 200000 }.Deserialize<Dictionary<string, object>>(line);
                        if ((string)command["action"] == "cancel") {
                            Interlocked.Increment(ref cancelEpoch); token = null;
                            Output(new { id = command["id"], canceled = true });
                        } else commands.Add(Tuple.Create(command, System.Threading.Volatile.Read(ref cancelEpoch)));
                    } catch { Output(new { id = 0, error = "input" }); }
                }
            } finally { commands.CompleteAdding(); Interlocked.Increment(ref cancelEpoch); }
        });
        reader.IsBackground=true;reader.Start();
        Console.WriteLine("{\"ready\":true}");
        foreach (var item in commands.GetConsumingEnumerable()) {
            object id = null;
            try {
                var command = item.Item1; operationEpoch = item.Item2; id = command["id"];
                if (operationEpoch != System.Threading.Volatile.Read(ref cancelEpoch)) throw new Exception("focus");
                var value = json.Deserialize<Dictionary<string, object>>(json.Serialize(Execute(command))); value["id"] = id;
                Output(value);
            } catch (Exception error) {
                string code = error.Message;
                if (code != "focus" && code != "target" && code != "selection" && code != "clipboard" && code != "modifiers" && code != "input" && code != "expired") code = "input";
                Output(new { id = id, error = code });
            }
        }
    }
}

// Windows turns Shift+numpad into navigation keys and emits artificial Shift events.
// Only configured Shift+numpad chords are matched; other keys are passed through,
// never converted to characters, retained, transmitted or logged.
public static class PairoNumpadHook {
    delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct KEY { public uint vk, scan, flags, time; public UIntPtr extra; }
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    static volatile object[] bindings = new object[0];
    static readonly int[] scans = { 0x52,0x4f,0x50,0x51,0x4b,0x4c,0x4d,0x47,0x48,0x49 };
    static HookProc callback;
    static IntPtr hook;
    static bool leftShift, rightShift;
    static readonly HashSet<uint> swallowed = new HashSet<uint>();
    static Action<string> dispatch;
    static bool Down(int key) { return (GetAsyncKeyState(key)&0x8000)!=0; }
    public static void Configure(object[] value) { bindings=value??new object[0]; }
    public static void Start(Action<string> handler) {
        dispatch=handler;
        var ready=new ManualResetEvent(false);
        var thread=new Thread(()=>{
            leftShift=Down(0xa0);rightShift=Down(0xa1);
            callback=Handle;
            hook=SetWindowsHookEx(13,callback,GetModuleHandle(null),0);ready.Set();
            if(hook!=IntPtr.Zero) { try{Application.Run();}finally{UnhookWindowsHookEx(hook);} }
        });
        thread.IsBackground=true;thread.SetApartmentState(ApartmentState.STA);thread.Start();
        if(!ready.WaitOne(3000)||hook==IntPtr.Zero) throw new Exception("input");
    }
    static IntPtr Handle(int code,IntPtr message,IntPtr data) {
        if(code<0)return CallNextHookEx(hook,code,message,data);
        var key=(KEY)Marshal.PtrToStructure(data,typeof(KEY));
        // Unicode SendInput uses scan as a UTF-16 unit, not a physical key scan code.
        if(key.vk==0xe7)return CallNextHookEx(hook,code,message,data);
        bool up=(key.flags&0x80)!=0;
        // Artificial numpad Shift up/down uses scan bit 0x200. It must not change physical state.
        if(key.vk==0xa0&&(key.scan==0x2a||key.scan==0))leftShift=!up;
        if(key.vk==0xa1&&(key.scan==0x36||key.scan==0))rightShift=!up;
        if((key.flags&1)==0&&swallowed.Contains(key.scan)) {
            if(up)swallowed.Remove(key.scan);
            return new IntPtr(1);
        }
        if(!up&&(key.flags&1)==0&&(leftShift||rightShift)) {
            int digit=Array.IndexOf(scans,(int)key.scan);
            if(digit>=0) {
                int modifiers=4|(Down(0x11)?2:0)|(Down(0x12)?1:0)|((Down(0x5b)||Down(0x5c))?8:0);
                foreach(object item in bindings) {
                    var binding=item as Dictionary<string,object>;
                    if(binding!=null&&Convert.ToInt32(binding["digit"])==digit&&Convert.ToInt32(binding["modifiers"])==modifiers) {
                        swallowed.Add(key.scan);dispatch((string)binding["action"]);return new IntPtr(1);
                    }
                }
            }
        }
        return CallNextHookEx(hook,code,message,data);
    }
}
