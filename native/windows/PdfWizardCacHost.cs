// PDF Wizard CAC helper for Windows: a Chrome/Edge native messaging host that signs SHA-256 digests
// with the private keys on a smart card (CAC / PIV) through the Windows certificate store (CNG or
// the card vendor's CSP, e.g. ActivClient). Windows shows its own PIN prompt; the PIN is never
// seen here. Only certificates whose key is on a hardware token are listed.
//
// Same protocol as native/macos/PdfWizardCacHost.swift (4-byte little-endian length + UTF-8 JSON):
//   {"type":"status"} | {"type":"list"} | {"type":"sign","certId","digest","hash":"sha256"}
//
// Written for the C# 5 compiler that ships with Windows (.NET Framework 4.6+), so it can be built
// without installing anything:  see install.ps1.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Web.Script.Serialization;

static class PdfWizardCacHost
{
    const string Version = "1.0.0";
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };

    static int Main(string[] args)
    {
        if (Array.IndexOf(args, "--list") >= 0)
        {
            foreach (var c in CardCertificates())
                Console.WriteLine(c.Subject + "\t" + Id(c) + "\t" + Provider(c));
            return 0;
        }
        var stdin = Console.OpenStandardInput();
        var stdout = Console.OpenStandardOutput();
        while (true)
        {
            var msg = Read(stdin);
            if (msg == null) return 0;
            Write(stdout, Handle(msg));
        }
    }

    // ── native messaging I/O ───────────────────────────────────────────────

    static byte[] ReadExactly(Stream s, int n)
    {
        var buf = new byte[n];
        int off = 0;
        while (off < n)
        {
            int r = s.Read(buf, off, n - off);
            if (r <= 0) return null;
            off += r;
        }
        return buf;
    }

    static Dictionary<string, object> Read(Stream s)
    {
        var header = ReadExactly(s, 4);
        if (header == null) return null;
        int len = BitConverter.ToInt32(header, 0);
        if (len <= 0 || len > 1 << 20) return null;
        var body = ReadExactly(s, len);
        if (body == null) return null;
        try { return Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body)); }
        catch { return new Dictionary<string, object>(); }
    }

    static void Write(Stream s, object reply)
    {
        var body = Encoding.UTF8.GetBytes(Json.Serialize(reply));
        var header = BitConverter.GetBytes(body.Length);
        s.Write(header, 0, 4);
        s.Write(body, 0, body.Length);
        s.Flush();
    }

    // ── certificates ───────────────────────────────────────────────────────

    static string Hex(byte[] b)
    {
        var sb = new StringBuilder(b.Length * 2);
        foreach (var x in b) sb.Append(x.ToString("x2"));
        return sb.ToString();
    }

    static string Id(X509Certificate2 c)
    {
        using (var sha = SHA256.Create()) return Hex(sha.ComputeHash(c.RawData));
    }

    /// Key storage provider / CSP name of the certificate's private key ("" if unknown).
    static string Provider(X509Certificate2 c)
    {
        try
        {
            var rsa = c.GetRSAPrivateKey();
            var cng = rsa as RSACng;
            if (cng != null) return cng.Key.Provider.Provider;
            var csp = rsa as RSACryptoServiceProvider;
            if (csp != null) return csp.CspKeyContainerInfo.ProviderName + (csp.CspKeyContainerInfo.HardwareDevice ? " (hardware)" : "");
        }
        catch { }
        try
        {
            var ec = c.GetECDsaPrivateKey() as ECDsaCng;
            if (ec != null) return ec.Key.Provider.Provider;
        }
        catch { }
        return "";
    }

    static bool OnHardware(X509Certificate2 c)
    {
        try
        {
            var rsa = c.GetRSAPrivateKey();
            var cng = rsa as RSACng;
            if (cng != null)
            {
                // Smart card KSPs: Microsoft's built-in one, or the card vendor's (ActivClient…).
                // Software keys and TPM keys are left out.
                var p = cng.Key.Provider.Provider;
                if (p == "Microsoft Software Key Storage Provider" || p == "Microsoft Platform Crypto Provider") return false;
                return p.IndexOf("Smart Card", StringComparison.OrdinalIgnoreCase) >= 0 || p.IndexOf("ActivClient", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            var csp = rsa as RSACryptoServiceProvider;
            if (csp != null) return csp.CspKeyContainerInfo.HardwareDevice || csp.CspKeyContainerInfo.Removable;
        }
        catch { }
        try
        {
            var ec = c.GetECDsaPrivateKey() as ECDsaCng;
            if (ec != null) return ec.Key.Provider.Provider.IndexOf("Smart Card", StringComparison.OrdinalIgnoreCase) >= 0;
        }
        catch { }
        return false;
    }

    static List<X509Certificate2> CardCertificates()
    {
        var result = new List<X509Certificate2>();
        var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
        try
        {
            foreach (var c in store.Certificates)
                if (c.HasPrivateKey && OnHardware(c)) result.Add(c);
        }
        finally { store.Close(); }
        return result;
    }

    static List<string> Chain(X509Certificate2 c)
    {
        var list = new List<string>();
        try
        {
            using (var chain = new X509Chain())
            {
                chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
                chain.ChainPolicy.VerificationFlags = X509VerificationFlags.AllFlags;
                chain.Build(c);
                for (int i = 1; i < chain.ChainElements.Count; i++) list.Add(Convert.ToBase64String(chain.ChainElements[i].Certificate.RawData));
            }
        }
        catch { }
        return list;
    }

    // ── requests ───────────────────────────────────────────────────────────

    static Dictionary<string, object> Ok(object result)
    {
        var d = new Dictionary<string, object>();
        d["ok"] = true;
        d["result"] = result;
        return d;
    }

    static Dictionary<string, object> Fail(string error)
    {
        var d = new Dictionary<string, object>();
        d["ok"] = false;
        d["error"] = error;
        return d;
    }

    static string Str(Dictionary<string, object> m, string key)
    {
        object v;
        return m.TryGetValue(key, out v) && v != null ? v.ToString() : null;
    }

    static Dictionary<string, object> Handle(Dictionary<string, object> msg)
    {
        try
        {
            var type = Str(msg, "type");
            if (type == "status")
            {
                var r = new Dictionary<string, object>();
                r["helper"] = true;
                r["version"] = Version;
                return Ok(r);
            }
            if (type == "list")
            {
                var certs = new List<object>();
                foreach (var c in CardCertificates())
                {
                    var e = new Dictionary<string, object>();
                    e["id"] = Id(c);
                    e["label"] = c.GetNameInfo(X509NameType.SimpleName, false);
                    e["der"] = Convert.ToBase64String(c.RawData);
                    e["chain"] = Chain(c);
                    e["hardware"] = true;
                    certs.Add(e);
                }
                var r = new Dictionary<string, object>();
                r["certificates"] = certs;
                return Ok(r);
            }
            if (type == "sign")
            {
                var certId = Str(msg, "certId");
                var hash = Str(msg, "hash");
                if (hash != null && hash != "sha256") return Fail("Only SHA-256 is supported.");
                byte[] digest;
                try { digest = Convert.FromBase64String(Str(msg, "digest") ?? ""); }
                catch { return Fail("Malformed signing request."); }
                if (digest.Length != 32) return Fail("Expected a SHA-256 digest.");
                X509Certificate2 cert = null;
                foreach (var c in CardCertificates()) if (Id(c) == certId) cert = c;
                if (cert == null) return Fail("The certificate isn't available. Is the card still in the reader?");
                var r = new Dictionary<string, object>();
                var rsa = cert.GetRSAPrivateKey();
                if (rsa != null)
                {
                    r["signature"] = Convert.ToBase64String(rsa.SignHash(digest, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
                    r["format"] = "pkcs1";
                    return Ok(r);
                }
                var ec = cert.GetECDsaPrivateKey();
                if (ec != null)
                {
                    r["signature"] = Convert.ToBase64String(ec.SignHash(digest));
                    r["format"] = "ecdsa-p1363";
                    return Ok(r);
                }
                return Fail("The card's key type isn't supported.");
            }
            return Fail("Unknown request.");
        }
        catch (CryptographicException e)
        {
            // 0x8010006E SCARD_W_CANCELLED_BY_USER, 0x800704C7 ERROR_CANCELLED
            if (e.HResult == unchecked((int)0x8010006E) || e.HResult == unchecked((int)0x800704C7)) return Fail("Signing was cancelled.");
            return Fail("The card refused to sign: " + e.Message);
        }
        catch (Exception e)
        {
            return Fail(e.Message);
        }
    }
}
