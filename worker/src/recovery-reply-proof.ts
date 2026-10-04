/** Read-only proof of the existing operator halt. Never prepare or repair a root. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { PERSISTENT_HOME_MANIFEST, verifyPersistentHome } from "./persistent-home";
export const recoveryReplyRefused = () => new Error("Reply-only prerequisites changed or could not be proved; financial holds remain intact.");
const stat = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
function fileProof(file: string, device: bigint): string | null {
    let fd: number;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
            return null;
        throw recoveryReplyRefused();
    }
    try {
        const s = fstatSync(fd, { bigint: true });
        if (!s.isFile() || s.dev !== device || s.nlink !== 1n || s.uid !== BigInt(process.geteuid!())
            || (s.mode & 4095n) !== 384n || s.size > 8192n)
            throw recoveryReplyRefused();
        const bytes = Buffer.alloc(8193);
        let n = 0;
        while (n < bytes.length) {
            const got = readSync(fd, bytes, n, bytes.length - n, n);
            if (!got)
                break;
            n += got;
        }
        if (BigInt(n) !== s.size || stat(fstatSync(fd, { bigint: true })) !== stat(s)
            || stat(lstatSync(file, { bigint: true })) !== stat(s))
            throw recoveryReplyRefused();
        return JSON.stringify([stat(s), bytes.subarray(0, n).toString("base64")]);
    }
    finally {
        closeSync(fd);
    }
}
export interface RecoveryReplyRootProof {
    assert(): void;
}
export function proveRecoveryReplyRoot(env: NodeJS.ProcessEnv = process.env, readMountInfo = () => readFileSync("/proc/self/mountinfo", "utf8")): RecoveryReplyRootProof {
    const home = env.MERRYMEN_HOME, volume = env.MERRYMEN_HOME_VOLUME_ID;
    const mode = () => {
        if (env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY !== "1" || env.MERRYMEN_FLEET_RECOVERY_REPLIES !== "1"
            || !["1", "true", "yes"].includes((env.MERRYMEN_HOSTED ?? "").trim().toLowerCase()) || !env.DATABASE_URL
            || env.MERRYMEN_PERSISTENT_HOME_REQUIRED !== "1" || !home || !path.isAbsolute(home) || path.resolve(home) !== home
            || home === path.parse(home).root || home.includes("\0") || home !== env.RAILWAY_VOLUME_MOUNT_PATH
            || !volume || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(volume) || !process.geteuid
            || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK
            || (env.MERRYMEN_INITIAL_HANDOVER !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(env.MERRYMEN_INITIAL_HANDOVER)))
            throw recoveryReplyRefused();
        const holds = env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
        if (holds !== undefined && holds.split(",").some(t => !/^0x[0-9a-f]{40}$/i.test(t.trim())))
            throw recoveryReplyRefused();
    };
    mode();
    const rootStat = lstatSync(home!, { bigint: true });
    const root = () => {
        mode();
        const s = lstatSync(home!, { bigint: true });
        if (!s.isDirectory() || realpathSync(home!) !== home || s.uid !== BigInt(process.geteuid!())
            || (s.mode & 4095n) !== 448n || stat(s) !== stat(rootStat))
            throw recoveryReplyRefused();
        const fd = openSync(home!, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
            if (stat(fstatSync(fd, { bigint: true })) !== stat(s))
                throw recoveryReplyRefused();
        }
        finally {
            closeSync(fd);
        }
        const text = readMountInfo();
        if (!text || text.length > 1024 * 1024)
            throw recoveryReplyRefused();
        let exact = 0;
        for (const line of text.split("\n")) {
            if (!line)
                continue;
            const parts = line.split(" - "), before = parts[0]?.split(" "), after = parts[1]?.split(" ");
            if (parts.length !== 2 || !before || before.length < 6 || !after || after.length !== 3
                || !/^\d+:\d+$/.test(before[2]!) || /\\(?!040|011|012|134)/.test(before[4]!))
                throw recoveryReplyRefused();
            const mount = before[4]!.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
            if (mount.startsWith(`${home}/`))
                throw recoveryReplyRefused();
            if (mount !== home)
                continue;
            exact++;
            const major = ((s.dev >> 8n) & 0xfffn) | ((s.dev >> 32n) & 0xfffff000n), minor = (s.dev & 0xffn) | ((s.dev >> 12n) & 0xffffff00n);
            if (before[2] !== `${major}:${minor}` || new Set(["overlay", "overlayfs", "tmpfs", "ramfs", "rootfs", "devtmpfs", "proc", "sysfs", "cgroup", "cgroup2", "mqueue", "hugetlbfs", "debugfs", "tracefs", "securityfs"]).has(after[0]!)
                || !before[5]!.split(",").includes("rw") || !after[2]!.split(",").includes("rw"))
                throw recoveryReplyRefused();
        }
        if (exact !== 1)
            throw recoveryReplyRefused();
    };
    root();
    const halt = fileProof(path.join(home!, "FLEET_HALT"), rootStat.dev);
    if (halt === null)
        throw recoveryReplyRefused();
    const manifest = fileProof(path.join(home!, PERSISTENT_HOME_MANIFEST), rootStat.dev);
    if (manifest !== null && !verifyPersistentHome(env, { readMountInfo }))
        throw recoveryReplyRefused();
    const keys = ["MERRYMEN_HOME", "MERRYMEN_HOME_VOLUME_ID", "RAILWAY_VOLUME_MOUNT_PATH", "MERRYMEN_HOSTED", "DATABASE_URL",
        "MERRYMEN_PERSISTENT_HOME_REQUIRED", "MERRYMEN_INITIAL_HANDOVER", "MERRYMEN_FLEET_RECOVERY_REPORT_ONLY", "MERRYMEN_FLEET_RECOVERY_REPLIES", "MERRYMEN_ACCOUNTING_HOLD_TENANTS", "MERRYMEN_TG_GROUPS"];
    const frozen = JSON.stringify(keys.map(k => env[k]));
    return { assert() {
            if (JSON.stringify(keys.map(k => env[k])) !== frozen)
                throw recoveryReplyRefused();
            root();
            if (fileProof(path.join(home!, "FLEET_HALT"), rootStat.dev) !== halt
                || fileProof(path.join(home!, PERSISTENT_HOME_MANIFEST), rootStat.dev) !== manifest)
                throw recoveryReplyRefused();
        } };
}
