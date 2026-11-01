/* Experimental Linux-only N-API helper for the descriptor-anchored permission
 * watcher. This draft is built and selected by virtualized-mount startup, but
 * must not be deployed until its full security and compatibility acceptance.
 *
 * Only the short native syscall runs under node's filesystem identity. The
 * process retains root credentials and restores them before returning to JS.
 */
#define _GNU_SOURCE
#include <node_api.h>
#include <uv.h>
#include <sys/fsuid.h>
#include <sys/inotify.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/syscall.h>
#include <fcntl.h>
#include <dirent.h>
#include <stdlib.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

/* Preserve Node-style errno codes for the existing read-only/mount policy. */
static napi_value fail_errno(napi_env env, int error_number) {
  napi_value code, message, error;
  const char *name = uv_err_name(uv_translate_sys_error(error_number));
  if (napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &code) != napi_ok ||
      napi_create_string_utf8(env, strerror(error_number), NAPI_AUTO_LENGTH, &message) != napi_ok ||
      napi_create_error(env, code, message, &error) != napi_ok)
    return fail(env, "Could not report filesystem error");
  napi_throw(env, error);
  return NULL;
}

static int number(napi_env env, napi_value value, int allow_zero, int *out) {
  double v;
  if (napi_get_value_double(env, value, &v) != napi_ok || !isfinite(v) ||
      floor(v) != v || v < (allow_zero ? 0 : 1) || v > INT_MAX) return 0;
  *out = (int)v;
  return 1;
}

struct fs_identity {
  uid_t uid;
  gid_t gid;
  int group_count;
  gid_t *groups;
};

/* Raw Linux syscalls change only this thread's credentials. The libc setgroups
 * wrapper broadcasts changes to every thread, which would be unsafe in Node. */
static void restore_identity(struct fs_identity old) {
  setfsuid(old.uid);
  if ((uid_t)setfsuid((uid_t)-1) != old.uid) _exit(127);
  setfsgid(old.gid);
  if ((gid_t)setfsgid((gid_t)-1) != old.gid) _exit(127);
  if (syscall(SYS_setgroups, old.group_count, old.groups) != 0) _exit(127);
  free(old.groups);
}

static int enter_identity(uid_t uid, gid_t gid, struct fs_identity *old) {
  if (geteuid() != 0 || uid == 0 || gid == 0) { errno = EPERM; return -1; }
  old->uid = (uid_t)setfsuid((uid_t)-1);
  old->gid = (gid_t)setfsgid((gid_t)-1);
  old->groups = NULL;
  old->group_count = 0;
  if (old->uid != 0 || old->gid != 0) { errno = EPERM; return -1; }
  long count = syscall(SYS_getgroups, 0, NULL);
  if (count < 0 || count > 1024) { errno = EPERM; return -1; }
  if (count) {
    old->groups = calloc((size_t)count, sizeof(gid_t));
    if (!old->groups) { errno = ENOMEM; return -1; }
    if (syscall(SYS_getgroups, count, old->groups) != count) {
      free(old->groups); old->groups = NULL; errno = EPERM; return -1;
    }
  }
  old->group_count = (int)count;
  if (syscall(SYS_setgroups, 0, NULL) != 0) {
    int error_number = errno; free(old->groups); old->groups = NULL;
    errno = error_number; return -1;
  }
  setfsgid(gid);
  if ((gid_t)setfsgid((gid_t)-1) != gid) {
    restore_identity(*old); errno = EPERM; return -1;
  }
  setfsuid(uid);
  if ((uid_t)setfsuid((uid_t)-1) != uid) {
    restore_identity(*old); errno = EPERM; return -1;
  }
  return 0;
}

/* Open exactly one raw byte path component relative to an already-validated
 * parent fd. The caller must validate the resulting fd's mount and inode. */
static napi_value open_child(napi_env env, napi_callback_info info) {
  size_t argc = 4, length = 0;
  napi_value args[4], result;
  void *data = NULL;
  int parent, uid, gid, fd, saved;
  struct stat st;
  struct fs_identity old;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc != 4 || !number(env, args[0], 1, &parent) ||
      napi_get_buffer_info(env, args[1], &data, &length) != napi_ok ||
      !number(env, args[2], 0, &uid) || !number(env, args[3], 0, &gid))
    return fail(env, "Invalid node-identity open arguments");
  if (length == 0 || length > NAME_MAX || memchr(data, '/', length) ||
      memchr(data, '\0', length) ||
      (length == 1 && ((char *)data)[0] == '.') ||
      (length == 2 && memcmp(data, "..", 2) == 0))
    return fail(env, "Invalid path component");
  if (fstat(parent, &st) != 0 || !S_ISDIR(st.st_mode))
    return fail(env, "Invalid parent directory descriptor");
  char name[NAME_MAX + 1];
  memcpy(name, data, length); name[length] = '\0';
  if (enter_identity((uid_t)uid, (gid_t)gid, &old) != 0)
    return fail(env, "Could not enter node filesystem identity");
  /* The watcher needs inode metadata, not file contents. O_PATH avoids
   * opening FIFOs/devices or holding a readable descriptor on a transient
   * SDK lock. Search permission on the parent is still checked as node; the
   * pinned entry is checked against the authorized mount before repair. */
  fd = openat(parent, name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  saved = errno;
  restore_identity(old);
  if (fd < 0) {
    /* Vanishing entries and symlinks are ordinary tree races. All other
     * errors remain visible to the trusted parent; never silently skip them. */
    if (saved == ENOENT || saved == ENOTDIR || saved == ELOOP || saved == ENXIO) {
      napi_get_null(env, &result); return result;
    }
    return fail_errno(env, saved);
  }
  napi_create_int32(env, fd, &result);
  return result;
}

/* Enumerate using an independent descriptor opened relative to the trusted
 * directory while node fsuid is active. No JS callbacks or allocations through
 * N-API occur before root identity is restored. Names stay raw bytes. */
static napi_value list_children(napi_env env, napi_callback_info info) {
  enum { MAX_ENTRIES = 32768, MAX_NAME_TOTAL = 8 * 1024 * 1024 };
  size_t argc = 3, count = 0, total = 0;
  napi_value args[3], result, item;
  int parent, uid, gid, fd = -1, saved = 0;
  struct fs_identity old;
  struct stat st;
  DIR *directory = NULL;
  char **names = NULL;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc != 3 || !number(env, args[0], 1, &parent) ||
      !number(env, args[1], 0, &uid) || !number(env, args[2], 0, &gid))
    return fail(env, "Invalid node-identity list arguments");
  if (fstat(parent, &st) != 0 || !S_ISDIR(st.st_mode))
    return fail(env, "Invalid list directory descriptor");
  names = calloc(MAX_ENTRIES, sizeof(*names));
  if (!names) return fail(env, "Could not allocate directory list");
  if (enter_identity((uid_t)uid, (gid_t)gid, &old) != 0) {
    free(names); return fail(env, "Could not enter node filesystem identity");
  }
  fd = openat(parent, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) { saved = errno; goto done; }
  directory = fdopendir(fd);
  if (!directory) { saved = errno; close(fd); goto done; }
  fd = -1; /* fdopendir owns it */
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (!entry) { saved = errno; break; }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
      continue;
    size_t length = strlen(entry->d_name);
    if (!length || length > NAME_MAX || count == MAX_ENTRIES ||
        total + length > MAX_NAME_TOTAL) { saved = EOVERFLOW; break; }
    names[count] = malloc(length + 1);
    if (!names[count]) { saved = ENOMEM; break; }
    memcpy(names[count], entry->d_name, length + 1);
    total += length; count++;
  }
done:
  if (directory && closedir(directory) != 0 && saved == 0) saved = errno;
  restore_identity(old);
  if (saved != 0) {
    for (size_t i = 0; i < count; i++) free(names[i]);
    free(names);
    return fail_errno(env, saved);
  }
  if (napi_create_array_with_length(env, count, &result) != napi_ok) {
    for (size_t i = 0; i < count; i++) free(names[i]);
    free(names); return fail(env, "Could not create directory list");
  }
  for (size_t i = 0; i < count; i++) {
    if (napi_create_buffer_copy(env, strlen(names[i]), names[i], NULL, &item) != napi_ok ||
        napi_set_element(env, result, (uint32_t)i, item) != napi_ok) {
      for (size_t j = 0; j < count; j++) free(names[j]);
      free(names); return fail(env, "Could not create directory entry");
    }
  }
  for (size_t i = 0; i < count; i++) free(names[i]);
  free(names); return result;
}

/* Apply a repair to the pinned inode only. The trusted JS normalizer must
 * validate its mount, inode type and hardlink policy before calling. O_PATH
 * descriptors support fchownat(AT_EMPTY_PATH); chmod uses the kernel's procfd
 * magic-link to the same still-open inode when fchmod cannot use O_PATH. */
static int repairable_fd(int fd, struct stat *st) {
  if (geteuid() != 0 || fstat(fd, st) != 0) return 0;
  return S_ISDIR(st->st_mode) || S_ISREG(st->st_mode) || S_ISFIFO(st->st_mode);
}

static napi_value chown_pinned(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value args[3], result;
  int fd, uid, gid; struct stat st;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc != 3 || !number(env, args[0], 1, &fd) ||
      !number(env, args[1], 1, &uid) || !number(env, args[2], 1, &gid) ||
      !repairable_fd(fd, &st))
    return fail(env, "Invalid pinned ownership repair");
  if (fchownat(fd, "", (uid_t)uid, (gid_t)gid, AT_EMPTY_PATH) != 0) {
    return fail_errno(env, errno);
  }
  napi_get_undefined(env, &result); return result;
}

static napi_value chmod_pinned(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2], result;
  int fd, mode, flags; struct stat st;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc != 2 || !number(env, args[0], 1, &fd) ||
      !number(env, args[1], 1, &mode) || mode > 07777 ||
      !repairable_fd(fd, &st))
    return fail(env, "Invalid pinned mode repair");
  flags = fcntl(fd, F_GETFL);
  if (flags < 0) return fail_errno(env, errno);
  if ((flags & O_PATH) == 0) {
    if (fchmod(fd, (mode_t)mode) != 0) {
      return fail_errno(env, errno);
    }
  } else {
    char proc_path[64];
    if (snprintf(proc_path, sizeof proc_path, "/proc/self/fd/%d", fd) >= (int)sizeof proc_path)
      return fail(env, "Invalid pinned mode descriptor");
    if (chmod(proc_path, (mode_t)mode) != 0) {
      return fail_errno(env, errno);
    }
  }
  napi_get_undefined(env, &result); return result;
}

static napi_value create_inotify(napi_env env, napi_callback_info info) {
  size_t argc = 0; napi_value result;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc != 0)
    return fail(env, "Invalid watcher arguments");
  int fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
  if (fd < 0) return fail_errno(env, errno);
  napi_create_int32(env, fd, &result); return result;
}

/* Register a non-recursive watch against the already-open directory. procfs
 * resolves only the parent process's descriptor, not a caller-supplied path. */
static napi_value add_watch(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value args[4], result;
  int notify, dir, uid, gid, wd, saved;
  struct stat st;
  struct fs_identity old;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc != 4 || !number(env, args[0], 1, &notify) ||
      !number(env, args[1], 1, &dir) || !number(env, args[2], 0, &uid) ||
      !number(env, args[3], 0, &gid))
    return fail(env, "Invalid node-identity watch arguments");
  if (fstat(dir, &st) != 0 || !S_ISDIR(st.st_mode))
    return fail(env, "Invalid watch directory descriptor");
  char proc_path[64];
  if (snprintf(proc_path, sizeof proc_path, "/proc/self/fd/%d", dir) >= (int)sizeof proc_path)
    return fail(env, "Invalid watch directory descriptor");
  if (enter_identity((uid_t)uid, (gid_t)gid, &old) != 0)
    return fail(env, "Could not enter node filesystem identity");
  wd = inotify_add_watch(notify, proc_path,
      IN_CREATE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO | IN_ATTRIB |
      IN_MODIFY | IN_DELETE_SELF | IN_MOVE_SELF | IN_ONLYDIR);
  saved = errno;
  restore_identity(old);
  if (wd < 0) return fail_errno(env, saved);
  napi_create_int32(env, wd, &result); return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"openChildAsNode", NULL, open_child, NULL, NULL, NULL, napi_default, NULL},
    {"listChildrenAsNode", NULL, list_children, NULL, NULL, NULL, napi_default, NULL},
    {"chownPinned", NULL, chown_pinned, NULL, NULL, NULL, napi_default, NULL},
    {"chmodPinned", NULL, chmod_pinned, NULL, NULL, NULL, napi_default, NULL},
    {"createInotify", NULL, create_inotify, NULL, NULL, NULL, napi_default, NULL},
    {"addWatchAsNode", NULL, add_watch, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, 6, properties) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
