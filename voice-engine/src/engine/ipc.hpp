#pragma once
#include <cerrno>
#include <cstdint>
#include <string>
#include <sys/socket.h>
#include <unistd.h>
namespace nv::ipc {
enum : uint32_t { ready=1, request=2, pcm=3, done=4, error=5 };
struct Header { uint32_t type, bytes; };
inline bool transfer(int fd,void* data,size_t count,bool writing) {
    auto* p=static_cast<char*>(data);
    while(count) {
        ssize_t n=writing?send(fd,p,count,MSG_NOSIGNAL):recv(fd,p,count,0);
        if(n<0&&errno==EINTR) continue;
        if(n<=0) return false;
        p+=n;count-=size_t(n);
    }
    return true;
}
inline bool write(int fd,const void* p,size_t n) {return transfer(fd,const_cast<void*>(p),n,true);}
inline bool read(int fd,void* p,size_t n) {return transfer(fd,p,n,false);}
inline bool message(int fd,uint32_t type,const void* p=nullptr,uint32_t n=0) {
    Header h{type,n};return write(fd,&h,sizeof h)&&(!n||write(fd,p,n));
}
inline bool text(int fd,uint32_t type,const std::string& s) {return message(fd,type,s.data(),uint32_t(s.size()));}
inline bool string_write(int fd,const std::string& s) {uint32_t n=uint32_t(s.size());return n<=1024*1024&&write(fd,&n,4)&&write(fd,s.data(),n);}
inline bool string_read(int fd,std::string& s) {uint32_t n;if(!read(fd,&n,4)||n>1024*1024)return false;s.resize(n);return read(fd,s.data(),n);}
}
