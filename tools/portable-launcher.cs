using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string target = Path.Combine(root, "IMB Files", "IMB.exe");
        if (!File.Exists(target))
        {
            MessageBox.Show("IMB Files 文件夹不完整，请重新解压便携版。", "IMB", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        var start = new ProcessStartInfo
        {
            FileName = target,
            WorkingDirectory = Path.GetDirectoryName(target),
            UseShellExecute = false,
            Arguments = string.Join(" ", args.Select(Quote))
        };
        Process.Start(start);
    }

    private static string Quote(string value)
    {
        if (string.IsNullOrEmpty(value)) return "\"\"";
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }
}
