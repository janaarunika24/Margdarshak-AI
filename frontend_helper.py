import os, sys, shutil

DEST = os.path.join("frontend", "dist")

def copy_build(src):
    if not os.path.isdir(src):
        raise Exception("Source not found: " + src)

    if os.path.exists(DEST):
        shutil.rmtree(DEST)

    shutil.copytree(src, DEST)
    print("Copied build →", DEST)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python frontend_helper.py /path/to/dist")
        sys.exit(1)
    copy_build(sys.argv[1])
